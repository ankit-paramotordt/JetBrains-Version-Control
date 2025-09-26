import * as vscode from 'vscode';
import * as simpleGit from 'simple-git';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

export function activate(context: vscode.ExtensionContext) {
  const provider = new VersionControlViewProvider(context.extensionUri, context);
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
  private readonly _localHistoryDir: string;
  
  constructor(
    private readonly _extUri: vscode.Uri, 
    private readonly _context?: vscode.ExtensionContext
  ) { 
    this._localHistoryDir = path.join(_extUri.fsPath, '..', 'local-history');
    // Ensure directory exists
    if (!fs.existsSync(this._localHistoryDir)) {
      fs.mkdirSync(this._localHistoryDir, { recursive: true });
    }
  }

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

    /* Set up file save tracking for Local History */
    if (this._context) {
      const saveListener = vscode.workspace.onDidSaveTextDocument(async (doc) => {
        if (doc.languageId && !doc.isUntitled) {
          await this.saveCurrentFileAsRevision('File save');
        }
      });
      this._context.subscriptions.push(saveListener);
    }
  }

  /* ── Handle messages coming from sidebar.html ────────────────────── */
  private async handleMessage(msg: any) {

    switch (msg.type) {
      case 'requestRefresh': return this.refreshFileList();
      case 'openDiff': return this.openDiff(msg.file);
      case 'requestShelf': return this.refreshShelf();
      case 'commitAndPush': return this.commitAndPush(msg.files, msg.message);
      case 'commit': return this.commitFiles(msg.files, msg.message);
      case 'rollback': return this.rollbackFiles(msg.files);
      case 'requestBranches': return this.sendBranchList();
      case 'updateFromRemote': return this.pullBranch(msg.branch);
      case 'pushBranch': return this.pushBranch(msg.branch);
      case 'createBranch': return this.createBranch(msg.name);
      case 'checkoutBranch': return this.checkoutBranch(msg.branch);
      case 'initGitRepo': return this.initGitRepo();
      
      // Local History handlers
      case 'requestLocalHistory': return this.sendLocalHistory();
      case 'selectRevision': return this.showRevisionDiff(msg.revisionId);
      case 'showAllHistory': return this.showAllHistory();
      case 'putHistoryLabel': return this.putHistoryLabel(msg.label);
      case 'clearLocalHistory': return this.clearLocalHistory();
      
      // Git Graph handlers  
      case 'requestGitGraph': return this.sendGitGraph();
      case 'selectCommit': return this.showCommitDetails(msg.hash);
      case 'cherryPickCommit': return this.cherryPickCommit(msg.hash);
      case 'revertCommit': return this.revertCommit(msg.hash);
      case 'resetToCommit': return this.resetToCommit(msg.hash);
      case 'compareCommits': return this.compareCommits();

      case 'ready':
        this._webviewReady = true;
        this.refreshFileList();
        return;
    }
  }

  /* ── Git helpers ─────────────────────────────────────────────────── */
  /* return the path to the current workspace */
  private get repoPath(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  }
  /* return true if `repoPath` really is a Git repo on disk */
  private async isGitRepo(): Promise<boolean> {
    const repo = this.repoPath;
    if (!repo) { return false; }
    try {
      return await simpleGit.default(repo).checkIsRepo();
    } catch {
      return false;
    }
  }
  /* ─── init a new Git repo ────────────────────────────────────────── */
  private async initGitRepo() {
    try {
      await this.git.init();
      vscode.window.showInformationMessage('Initialized a new Git repository.');
      this.refreshFileList(); // Refresh UI now that it's a git repo
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to initialize Git repository: ${err.message}`);
    }
  }
  /* ─── get a simple-git instance for the current workspace ───────── */
  private get git() {
    const repo = this.repoPath;
    if (!repo) { throw new Error('No open workspace.'); }
    return simpleGit.default(repo);
  }
  /* ───────── branch helpers ───────────────────────────────────────── */

  private async sendBranchList() {
    if (!this._view || !this._webviewReady) return;
    const summary = await this.git.branch();

    const locals = Object.keys(summary.branches)
      .filter(b => !b.startsWith('remotes/'));
    const remotes = Object.keys(summary.branches)
      .filter(b => b.startsWith('remotes/'))
      .map(b => b.replace(/^remotes\//, ''));

    this._view.webview.postMessage({
      type: 'branchList',
      current: summary.current,
      locals,
      remotes
    });
  }

  private async pullBranch(branch: string) {
    try {
      /* branch may be  "origin/main" (remote) or "main" (local) */
      if (branch.includes('/')) {
        const [remote, br] = branch.split('/', 2);
        await this.git.pull(remote, br);
      } else {
        await this.git.pull('origin', branch);
      }
      vscode.window.showInformationMessage(`Pulled ${branch}.`);
      this.refreshShelf();
    } catch (e: any) {
      vscode.window.showErrorMessage(`Pull failed: ${e.message}`);
    }
  }

  private async pushBranch(branch: string) {
    try {
      const status = await this.git.status();

      let remote = status.tracking?.split('/')[0];
      let setUpstream = false;

      if (!remote) {
        // No tracking branch configured, ask user to select remote
        const remotes = await this.git.getRemotes(true);

        if (!remotes.length) {
          vscode.window.showWarningMessage('No Git remotes are configured.');
          return;
        }

        const selected = await vscode.window.showQuickPick(
          remotes.map(r => r.name),
          { placeHolder: 'Select a remote to push to:' }
        );

        if (!selected) {
          vscode.window.showInformationMessage('Push cancelled.');
          return;
        }

        remote = selected;
        setUpstream = true;
      }

      if (setUpstream) {
        await this.git.push(['--set-upstream', remote, branch]);
      } else {
        await this.git.push(remote, branch);
      }

      vscode.window.showInformationMessage(`Pushed ${branch} to ${remote}.`);
      this.refreshShelf();
    } catch (e: any) {
      vscode.window.showErrorMessage(`Push failed: ${e.message}`);
    }
  }

  private async createBranch(name: string) {
    try {
      await this.git.checkoutLocalBranch(name);
      vscode.window.showInformationMessage(`Created & checked-out ${name}.`);
      this.sendBranchList();          // update dropdown
      this.refreshShelf();
    } catch (e: any) {
      vscode.window.showErrorMessage(`Cannot create branch: ${e.message}`);
    }
  }
  private async checkoutBranch(name: string) {
    try {
      await this.git.checkout(name);
      vscode.window.showInformationMessage(`Switched to branch ${name}.`);
      this.sendBranchList();          // refresh dropdown
      this.refreshShelf();            // optional: reload shelf state
    } catch (e: any) {
      vscode.window.showErrorMessage(`Cannot switch branch: ${e.message}`);
    }
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
    if (!(await this.isGitRepo())) {
      this._view.webview.postMessage({ type: 'notGitRepo' });
      return;
    }

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
      // Stage and commit
      await this.git.add(files);
      await this.git.commit(message, files);

      // Check current status
      const status = await this.git.status();

      if (!status.current || status.detached) {
        const newBranch = await vscode.window.showInputBox({
          prompt: 'You are in a detached HEAD state. Enter a name for a new branch to push your commit:',
          placeHolder: 'e.g. main, feature/login'
        });

        if (!newBranch) {
          vscode.window.showWarningMessage('Commit was created, but push was cancelled (no branch selected).');
          return;
        }

        // Create and switch to new branch
        await this.git.checkoutLocalBranch(newBranch);
        vscode.window.showInformationMessage(`Created and switched to branch '${newBranch}'`);
      }

      // Determine remote
      let remote = status.tracking?.split('/')[0];
      let setUpstream = false;

      if (!remote) {
        const remotes = await this.git.getRemotes(true);

        if (!remotes.length) {
          vscode.window.showWarningMessage('No Git remotes are configured.');
          return;
        }

        const selected = await vscode.window.showQuickPick(
          remotes.map(r => r.name),
          { placeHolder: 'Select a remote to push to:' }
        );

        if (!selected) {
          vscode.window.showInformationMessage('Commit complete, but push cancelled.');
          return;
        }

        remote = selected;
        setUpstream = true;
      }

      // Push with or without upstream depending on state
      const currentBranch = (await this.git.status()).current!;
      if (setUpstream) {
        await this.git.push(['--set-upstream', remote, currentBranch]);
      } else {
        await this.git.push(remote, currentBranch);
      }

      vscode.window.showInformationMessage(`Commit and push successful to ${remote}/${currentBranch}.`);
      this.refreshFileList();
      this.refreshShelf();

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
      this._debounce = setTimeout(() => {
        this.refreshFileList();
        // Auto-save file to local history for active file changes
        this.autoSaveToLocalHistory();
      }, 200);
    };

    this._watcher.onDidCreate(trigger);
    this._watcher.onDidChange(trigger);
    this._watcher.onDidDelete(trigger);

    /* stop watching when the webview disappears */
    this._view?.onDidDispose(() => this._watcher?.dispose());
  }

  private lastSaveTime: { [file: string]: number } = {};

  private async autoSaveToLocalHistory() {
    const activeFile = vscode.window.activeTextEditor?.document;
    if (!activeFile || activeFile.isUntitled) return;

    const now = Date.now();
    const filePath = activeFile.uri.fsPath;
    const lastSave = this.lastSaveTime[filePath] || 0;

    // Only save to history every 30 seconds to avoid spam
    if (now - lastSave > 30000) {
      this.lastSaveTime[filePath] = now;
      await this.saveCurrentFileAsRevision('Auto save');
    }
  }

  /* ── Local History functionality ───────────────────────────────── */

  private async sendLocalHistory() {
    if (!this._view || !this._webviewReady) return;
    
    try {
      const revisions = await this.getLocalHistoryRevisions();
      this._view.webview.postMessage({ type: 'localHistoryList', revisions });
    } catch (err: any) {
      vscode.window.showErrorMessage(`Local History error: ${err.message}`);
    }
  }

  private async getLocalHistoryRevisions(): Promise<any[]> {
    const revisions: any[] = [];
    const workspacePath = this.repoPath;
    
    if (!workspacePath) return revisions;

    const historyDir = path.join(this._localHistoryDir, workspacePath.replace(/[^a-zA-Z0-9]/g, '_'));
    
    if (!fs.existsSync(historyDir)) return revisions;

    const files = fs.readdirSync(historyDir).sort().reverse();
    
    for (const file of files) {
      const filePath = path.join(historyDir, file);
      const stat = fs.statSync(filePath);
      
      const content = fs.readFileSync(filePath, 'utf-8');
      let revisionData;
      try {
        revisionData = JSON.parse(content);
      } catch {
        continue;
      }

      revisions.push({
        id: file.replace('.json', ''),
        timestamp: stat.mtime.getTime(),
        label: revisionData.label || 'Manual save',
        content: revisionData.content,
        files: revisionData.files || []
      });
    }

    return revisions;
  }

  private async showRevisionDiff(revisionId: string) {
    if (!this._view || !this._webviewReady) return;
    
    try {
      const revisions = await this.getLocalHistoryRevisions();
      const revision = revisions.find(r => r.id === revisionId);
      
      if (revision) {
        // For simplicity, show diff content - in full implementation this would
        // compare with current content or previous revision
        this._view.webview.postMessage({ 
          type: 'revisionDiff', 
          diff: revision.content,
          label: revision.label 
        });
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`Local History diff error: ${err.message}`);
    }
  }

  private async showAllHistory() {
    await this.sendLocalHistory();
  }

  private async putHistoryLabel(label: string) {
    const activeFile = vscode.window.activeTextEditor?.document;
    if (!activeFile) {
      vscode.window.showWarningMessage('No active file to label');
      return;
    }

    try {
      await this.saveCurrentFileAsRevision(label);
      await this.sendLocalHistory();
      vscode.window.showInformationMessage(`Label "${label}" created`);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Error creating label: ${err.message}`);
    }
  }

  private async clearLocalHistory() {
    const workspacePath = this.repoPath;
    if (!workspacePath) return;

    const historyDir = path.join(this._localHistoryDir, workspacePath.replace(/[^a-zA-Z0-9]/g, '_'));
    
    if (fs.existsSync(historyDir)) {
      fs.rmSync(historyDir, { recursive: true, force: true });
      vscode.window.showInformationMessage('Local History cleared');
      await this.sendLocalHistory();
    }
  }

  private async saveCurrentFileAsRevision(label?: string) {
    const activeFile = vscode.window.activeTextEditor?.document;
    if (!activeFile) return;

    const workspacePath = this.repoPath;
    if (!workspacePath) return;

    const historyDir = path.join(this._localHistoryDir, workspacePath.replace(/[^a-zA-Z0-9]/g, '_'));
    
    if (!fs.existsSync(historyDir)) {
      fs.mkdirSync(historyDir, { recursive: true });
    }

    const content = activeFile.getText();
    const relativePath = path.relative(workspacePath, activeFile.uri.fsPath);
    const revisionId = Date.now().toString();

    const revisionData = {
      label: label || 'Manual save',
      files: [relativePath],
      content: content,
      timestamp: Date.now(),
      filePath: relativePath
    };

    const revisionFile = path.join(historyDir, `${revisionId}.json`);
    fs.writeFileSync(revisionFile, JSON.stringify(revisionData, null, 2));
  }

  /* ── Git Graph functionality ─────────────────────────────────── */

  private async sendGitGraph() {
    if (!this._view || !this._webviewReady) return;
    
    try {
      const branches = await this.getBranchesForGraph();
      const commits = await this.getCommitsForGraph();
      
      this._view.webview.postMessage({ 
        type: 'gitGraphData', 
        branches, 
        commits 
      });
    } catch (err: any) {
      vscode.window.showErrorMessage(`Git Graph error: ${err.message}`);
    }
  }

  private async getBranchesForGraph() {
    const summary = await this.git.branch();
    
    const locals = Object.keys(summary.branches)
      .filter(b => !b.startsWith('remotes/'));
    const remotes = Object.keys(summary.branches)
      .filter(b => b.startsWith('remotes/'))
      .map(b => b.replace(/^remotes\//, ''));

    return { locals, remotes, current: summary.current };
  }

  private async getCommitsForGraph() {
    const log = await this.git.log({
      maxCount: 100
    });

    return log.all.map(commit => ({
      hash: commit.hash,
      message: commit.message,
      author: commit.author_name,
      date: commit.date,
      parents: commit.hash // simplify for now
    }));
  }

  private async showCommitDetails(hash: string) {
    if (!this._view || !this._webviewReady) return;
    
    try {
      const git = this.git;
      const commitData = await git.show(['--name-status', hash]);
      const commitInfo = await git.log({ from: hash, to: hash, maxCount: 1 });
      
      const changedFiles = await this.getChangedFilesForCommit(hash);

      this._view.webview.postMessage({
        type: 'commitDetails',
        commit: commitInfo.all[0],
        changedFiles,
        diff: commitData
      });
    } catch (err: any) {
      vscode.window.showErrorMessage(`Git details error: ${err.message}`);
    }
  }

  private async getChangedFilesForCommit(hash: string) {
    try {
      const git = this.git;
      const result = await git.raw(['show', '--name-status', hash]);
      
      return result.split('\n')
        .filter(line => line.trim())
        .map(line => {
          const [status, file] = line.split('\t', 2);
          return { status: status.charAt(0), file };
        });
    } catch {
      return [];
    }
  }

  private async cherryPickCommit(hash: string) {
    try {
      await this.git.raw(['cherry-pick', hash]);
      vscode.window.showInformationMessage(`Cherry-picked commit ${hash.substring(0, 7)}`);
      this.refreshFileList();
    } catch (err: any) {
      vscode.window.showErrorMessage(`Cherry-pick failed: ${err.message}`);
    }
  }

  private async revertCommit(hash: string) {
    try {
      await this.git.revert(hash);
      vscode.window.showInformationMessage(`Reverted commit ${hash.substring(0, 7)}`);
      this.refreshFileList();
    } catch (err: any) {
      vscode.window.showErrorMessage(`Revert failed: ${err.message}`);
    }
  }

  private async resetToCommit(hash: string) {
    try {
      await this.git.raw(['reset', '--hard', hash]);
      vscode.window.showInformationMessage(`Reset to commit ${hash.substring(0, 7)}`);
      this.refreshFileList();
    } catch (err: any) {
      vscode.window.showErrorMessage(`Reset failed: ${err.message}`);
    }
  }

  private async compareCommits() {
    vscode.window.showInformationMessage('Compare commits - feature coming soon!');
  }

  /* ── clean‑up when extension is deactivated ──────────────────────── */
  public dispose() {
    this._watcher?.dispose();
  }
}
