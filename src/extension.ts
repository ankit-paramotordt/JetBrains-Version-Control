import * as vscode from 'vscode';
import * as simpleGit from 'simple-git';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
  const provider = new VersionControlViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      VersionControlViewProvider.viewType,
      provider
    ),
    provider   // dispose‑on‑extension‑deactivate
  );
}

export function deactivate() { /* nothing to do, disposables handle it */ }

  
/* ────────────────────────────────────────────────────────────────────── */

class VersionControlViewProvider
  implements vscode.WebviewViewProvider, vscode.Disposable {

  public static readonly viewType = 'versionControlView';

  private _view?: vscode.WebviewView;
  private _watcher?: vscode.FileSystemWatcher;
  private _debounce?: NodeJS.Timeout;
  private _webviewReady = false;
  constructor(private readonly _extUri: vscode.Uri) { }

  /* ── VS Code calls this when the sidebar becomes visible ─────────── */
  public async resolveWebviewView(view: vscode.WebviewView) {
    this._view = view;
    this._webviewReady = false;
    /* html ──────────────────────────────────────────── */
    const htmlPath =
      vscode.Uri.joinPath(this._extUri, 'media', 'sidebar.html');
    const cssUri = view.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extUri, 'media', 'codicon.css')
    );

    const bytes = await vscode.workspace.fs.readFile(htmlPath);
    const html = Buffer.from(bytes).toString('utf8')
      .replace('__CODICON_CSS__', cssUri.toString());

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extUri]
    };
    view.webview.html = html;

    /* first paint + live watcher ──────────────────────────────────── */
    await this.refreshFileList();
    this.startFileWatcher();

    /* messages from the webview ───────────────────────────────── */
    view.webview.onDidReceiveMessage(msg => this.handleMessage(msg));
  }

  /* ── Handle messages coming from sidebar.html ────────────────────── */
  private async handleMessage(msg: any) {

    switch (msg.type) {
      case 'requestRefresh':
        return this.refreshFileList();
      case 'openDiff':
        return this.openDiff(msg.file);
      case 'requestShelf':
        return this.refreshShelf();
      case 'commitAndPush':
        return this.commitAndPush(msg.files, msg.message);

      case 'commit':
        return this.commitFiles(msg.files, msg.message);

      case 'rollback':
        return this.rollbackFiles(msg.files);
      case 'ready':
        this._webviewReady = true;
        this.refreshFileList();
        return;
    }
  }

  /* ── Git helpers ─────────────────────────────────────────────────── */
  private get repoPath(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  }

  private get git() {
    const repo = this.repoPath;
    if (!repo) { throw new Error('No open workspace.'); }
    return simpleGit.default(repo);
  }
  /* ─── open HEAD to working‑copy diff ─────────────────────────────────── */
  private async openDiff(relPath: string) {
    const repo = this.repoPath;
    if (!repo) { return; }

    const right = vscode.Uri.file(path.join(repo, relPath));

    /* ───HEAD content  ─────────────────────────────────── */
    let headContent: string;
    try {
      headContent = await this.git.show([`HEAD:${relPath.replace(/\\/g, '/')}`]);
    } catch {
      vscode.window.showInformationMessage(
        `"${relPath}" is new – nothing to diff against HEAD.`
      );
      return;
    }

    /* ─── create untitled doc) ─────────────────────────── */
    let leftDoc = await vscode.workspace.openTextDocument({
      content: headContent,
      language: 'plaintext'
    });

    /* ───  try to set a better language based on the extension ───────── */
    const ext = path.extname(relPath).slice(1);   // ".ts" -> "ts"
    if (ext) {
      try {
        leftDoc = await vscode.languages.setTextDocumentLanguage(leftDoc, ext);
      } catch {
        /* ignore – keep plaintext if VS Code has no grammar for ext */
      }
    }

    /* ────── open the diff ────────────────────────────────────────── */
    const title = `${relPath} (HEAD ↔ Working Tree)`;
    await vscode.commands.executeCommand(
      'vscode.diff',
      leftDoc.uri,
      right,
      title,
      { preview: true }
    );
  }


  private async commitFiles(files: string[], message: string) {
    try {
      await this.git.add(files);
      await this.git.commit(message, files);
      vscode.window.showInformationMessage('✅ Commit successful');
    } catch (err: any) {
      vscode.window.showErrorMessage(`❌ Git commit failed: ${err.message}`);
    }
    this.refreshFileList();
    await this.refreshShelf();
  }

  /* ─── Roll back: un‑stage   + restore work‑tree ─────────────────────── */
  private async rollbackFiles(files: string[]) {
    if (!files.length) { return; }

    try {
      /* ───make paths OS‑independent and relative to the repo root ──────*/
      const normalised = files.map(f => f.replace(/\\/g, '/'));

      /* ──────unstage anything already in the index ───────────────────── */
      await this.git.reset(['HEAD', '--', ...normalised]);

      /* discard edits in the working tree                       */
      // simple‑git’s .checkout() expects a branch name, so we use .raw()
      await this.git.raw(['checkout', 'HEAD', '--', ...normalised]);

      vscode.window.showInformationMessage(
        `⟲ Rolled back ${files.length} file(s) to HEAD.`
      );
    } catch (err: any) {
      // show the *exact* Git error so you see what went wrong in Debug mode
      vscode.window.showErrorMessage(`❌ Roll-back failed: ${err.stderr || err}`);
    }

    await this.refreshFileList();  // update the sidebar
    await this.refreshShelf(); // update shelf view
  }



  /* ── Build the JSON we send to the webview ───────────────────────── */
  private async refreshFileList() {
    if (!this._view || !this._webviewReady) { return; }

    try {
      const status = await this.git.status();
      const changes = {
        staged: status.staged,
        modified: status.modified,
        not_added: status.not_added
      };
      this._view.webview.postMessage({ type: 'fileList', changes });
    } catch (err: any) {
      vscode.window.showErrorMessage(`Git error: ${err.message}`);
    }
  }
  private async commitAndPush(files: string[], message: string) {
    try {
      await this.git.add(files);
      await this.git.commit(message, files);
      await this.git.push();

      vscode.window.showInformationMessage('Commit and push successful.');
      this.refreshFileList(); // update UI
      this.refreshShelf();    // update shelf view
    } catch (err: any) {
      vscode.window.showErrorMessage(`Commit & Push failed: ${err.message}`);
    }
  }

  /** Send every commit that is ahead of the branch’s upstream */
  private async refreshShelf() {
    if (!this._view || !this._webviewReady) return;

    try {
      const status = await this.git.status();
      let commits: { hash: string; message: string }[] = [];

      if (status.tracking) {
        /* normal case: branch has an upstream */
        const log = await this.git.log({ from: status.tracking, to: 'HEAD' });
        commits = log.all.map(c => ({ hash: c.hash, message: c.message }));
      } else {
        /* fallback: branch has NO upstream – show everything
           that isn’t on ANY remote                                 */
        const raw = await this.git.raw([
          'log', '--branches', '--not', '--remotes',
          '--pretty=%H:::%s'
        ]);
        commits = raw.trim()
          .split('\n')
          .filter(Boolean)
          .map(l => {
            const [hash, message] = l.split(':::');
            return { hash, message };
          });
      }

      this._view.webview.postMessage({ type: 'shelfList', commits });
    } catch (err: any) {
      vscode.window.showErrorMessage(`Git error (Shelf): ${err.message}`);
    }
  }


  /* ── Only refresh when something changes on disk ─────────────────── */
  private startFileWatcher() {
    /* dispose old watcher (view can be reopened) */
    this._watcher?.dispose();

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { return; }

    this._watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, '**/*')
    );

    const trigger = () => {
      clearTimeout(this._debounce);
      this._debounce = setTimeout(() => this.refreshFileList(), 200);
    };

    this._watcher.onDidCreate(trigger);
    this._watcher.onDidChange(trigger);
    this._watcher.onDidDelete(trigger);

    /* stop watching when the webview disappears */
    this._view?.onDidDispose(() => this._watcher?.dispose());
  }

  /* ── clean‑up when extension is deactivated ──────────────────────── */
  public dispose() {
    this._watcher?.dispose();
  }
}
