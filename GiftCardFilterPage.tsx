import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";

import type { ApiCategory, ApiGiftCard } from "@/types/api";

import { ConsumerLayout } from "@/components/consumer/ConsumerLayout";
import { GiftCardItem } from "@/components/consumer/GiftCardItem";
import GiftCardShimmer from "@/components/consumer/Shimmer/GiftCardShimmer";
import GiftLoader from "@/components/ui/GiftLoader.tsx";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// API
import {
  fetchCategories,
  fetchGiftCards,
  fetchGiftCardsByCategory,
  searchGiftCards,
} from "@/services/apiService.ts";
import { fetchGiftCardDealProducts } from "@/services/productServiceTypes.ts";

function normalize(s?: string | null) {
  return (s ?? "")
    .replace(/\+/g, " ")
    .replace(/&amp;/gi, "&")
    .trim()
    .toLowerCase();
}

const GiftCardFilterPage: React.FC = () => {
  const location = useLocation();

  // Data/UI state
  const [isLoading, setIsLoading] = useState(false);
  const [categories, setCategories] = useState<ApiCategory[]>([]);
  const [categoriesLoaded, setCategoriesLoaded] = useState(false);
  const [isCategoryResolved, setIsCategoryResolved] = useState(false);
  const [cards, setCards] = useState<ApiGiftCard[]>([]);
  const [page, setPage] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [hasMore, setHasMore] = useState(true);

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");

  // Simplified filter state
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [categoryName, setCategoryName] = useState<string>("");

  // Sort state
  const [sortBy, setSortBy] = useState<"paramotorDiscount" | "newest" | "oldest" | "name" | undefined>(undefined);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [sortMenuOpen, setSortMenuOpen] = useState(false);

  // Optional deal title
  const [dealTitle, setDealTitle] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  // Infinite scroll
  const observerTarget = useRef<HTMLDivElement>(null);
  const [useInfiniteScroll, setUseInfiniteScroll] = useState(true);

  // Debounced search
  const debounceTimeoutRef = useRef<NodeJS.Timeout>();
  const debouncedSearch = useCallback((query: string) => {
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }
    debounceTimeoutRef.current = setTimeout(() => {
      const trimmedQuery = query.trim();
      if (trimmedQuery !== submittedQuery) {
        setSubmittedQuery(trimmedQuery);
        setSelectedCategoryId(null);
        setCategoryName("");
        setCards([]);
        setPage(0);
        setTotalPages(0);
        setHasMore(true);
      }
    }, 500);
  }, [submittedQuery]);

  useEffect(() => {
    debouncedSearch(searchQuery);
    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
    };
  }, [searchQuery, debouncedSearch]);

  // Load categories once
  useEffect(() => {
    const loadCategories = async () => {
      try {
        const fetched = await fetchCategories();
        setCategories(fetched);
      } finally {
        setCategoriesLoaded(true);
      }
    };
    loadCategories();
  }, []);

  // Parse category from URL
  useEffect(() => {
    const qs = new URLSearchParams(location.search);
    const raw = qs.get("category") ?? qs.get("categoryId") ?? qs.get("categorySlug");
    const norm = normalize(raw);

    if (!norm) {
      setSelectedCategoryId(null);
      setCategoryName("");
      setIsCategoryResolved(true);
      return;
    }

    if (!categoriesLoaded) {
      setIsCategoryResolved(false);
      return;
    }

    const matchedCategory = categories.find(c =>
      String(c.id) === raw || normalize(c.name) === norm,
    );

    if (matchedCategory) {
      setSelectedCategoryId(String(matchedCategory.id));
      setCategoryName(matchedCategory.name);
    } else {
      setSelectedCategoryId(null);
      setCategoryName(raw ?? "");
    }

    setIsCategoryResolved(true);
  }, [categories, location.search, categoriesLoaded]);

  // Reset data when filters change
  useEffect(() => {
    setCards([]);
    setPage(0);
    setTotalPages(0);
    setHasMore(true);
  }, [selectedCategoryId, submittedQuery, sortBy, sortDirection]);

  // Fetch deal title from URL
  useEffect(() => {
    const qs = new URLSearchParams(location.search);
    const dealId = qs.get("dealId") ?? qs.get("deal") ?? qs.get("id");
    if (!dealId) {
      setDealTitle(null);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await fetchGiftCardDealProducts(dealId);
        if (cancelled) return;
        const title = res?.responseData?.name ?? res?.responseData?.heading ?? null;
        setDealTitle(title);
      } catch (e) {
        setDealTitle(null);
        console.warn("Failed to fetch deal title for dealId:", dealId, e);
      }
    })();

    return () => { cancelled = true; };
  }, [location.search]);

  // Main fetch effect
  useEffect(() => {
    if (!isCategoryResolved) return;

    let cancelled = false;

    const loadGiftCards = async () => {
      if (page === 0) {
        setIsLoading(true);
      } else {
        setIsLoadingMore(true);
      }

      try {
        let newCards: ApiGiftCard[] = [];
        let totalPages = 0;

        if (submittedQuery && submittedQuery.length > 0) {
          // Search mode
          const res = await searchGiftCards(submittedQuery, page, 20, sortBy as any, sortDirection as any);
          if (cancelled) return;
          newCards = res.responseData?.products || [];
          totalPages = res.responseData?.totalPages || 0;
        } else if (selectedCategoryId) {
          // Category mode - use the old API approach for proper pagination
          if (page === 0) {
            // For first page, fetch all category products and handle pagination client-side
            const res = await fetchGiftCardsByCategory(selectedCategoryId);
            if (cancelled) return;
            const allCards = res.responseData?.products || [];
            
            // Client-side pagination
            const startIndex = page * 20;
            const endIndex = startIndex + 20;
            newCards = allCards.slice(startIndex, endIndex);
            totalPages = Math.ceil(allCards.length / 20);
          } else {
            // For subsequent pages, return empty array as we've already loaded all data
            newCards = [];
            totalPages = 0;
          }
        } else {
          // General mode
          const res = await fetchGiftCards(page, 20, undefined, undefined, sortBy as any, sortDirection as any);
          if (cancelled) return;
          newCards = res.responseData?.products || [];
          totalPages = res.responseData?.totalPages || 0;
        }

        setTotalPages(totalPages);
        setHasMore(page + 1 < totalPages);

        setCards((prev) => {
          const allCards = page === 0 ? newCards : [...prev, ...newCards];
          const uniqueCards = Array.from(new Map(allCards.map(card => [card.sku, card])).values());

          // Apply client-side sorting if needed
          if (sortBy) {
            uniqueCards.sort((a, b) => {
              if (sortBy === "paramotorDiscount") {
                const av = Number(a.paramotorDiscount ?? 0);
                const bv = Number(b.paramotorDiscount ?? 0);
                return sortDirection === "asc" ? av - bv : bv - av;
              }
              if (sortBy === "name") {
                return sortDirection === "asc"
                  ? a.name.localeCompare(b.name)
                  : b.name.localeCompare(a.name);
              }
              const at = Date.parse((a as any).createdAt ?? (a as any).updatedAt ?? "") || 0;
              const bt = Date.parse((b as any).createdAt ?? (b as any).updatedAt ?? "") || 0;
              if (sortBy === "newest") {
                return sortDirection === "asc" ? at - bt : bt - at;
              }
              return sortDirection === "asc" ? bt - at : at - bt; // oldest
            });
          }
          return uniqueCards;
        });
      } catch (e) {
        console.error("Failed to load gift cards:", e);
        if (!cancelled) {
          setCards([]);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
          setIsLoadingMore(false);
        }
      }
    };

    loadGiftCards();
    return () => { cancelled = true; };
  }, [page, selectedCategoryId, sortBy, sortDirection, submittedQuery, isCategoryResolved]);

  // Infinite scroll observer
  useEffect(() => {
    if (!observerTarget.current || !hasMore || isLoadingMore || !useInfiniteScroll) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setPage(prev => prev + 1);
        }
      },
      { threshold: 0.1 },
    );

    observer.observe(observerTarget.current);
    return () => observer.disconnect();
  }, [hasMore, isLoadingMore, useInfiniteScroll]);

  // Handle load more button click
  const handleLoadMore = () => {
    if (hasMore && !isLoadingMore) {
      setPage(prev => prev + 1);
    }
  };

  // Toggle between infinite scroll and load more button
  const toggleScrollMode = () => {
    setUseInfiniteScroll(prev => !prev);
  };

  const displayedCards = useMemo(() => {
    return cards.filter(card => card?.sku && card.sku.length > 3);
  }, [cards]);

  const pageTitle = dealTitle
    || (submittedQuery
      ? `Search results for "${submittedQuery}"`
      : (categoryName ? `${categoryName} Gift Cards` : "All Gift Cards"));

  return (
    <ConsumerLayout>
      {isLoading && page === 0 && (
        <div className="fixed inset-0 z-[100] grid place-items-center bg-black/40 backdrop-blur-lg">
          <div className="rounded-2xl border border-white/60 dark:border-white/10 bg-white/90 dark:bg-neutral-900/90 px-6 py-5 shadow-xl">
            <GiftLoader label="Loading gift cards..." size="lg" />
          </div>
        </div>
      )}

      <div className="container mx-auto px-4 py-8">
        <div className="mb-8">
          <div className="flex items-center gap-4">
            <div className="flex-none mr-4">
              <h1
                className="
                  relative isolate
                  inline-flex items-center gap-3
                  text-2xl md:text-4xl font-extrabold leading-tight
                  tracking-tight
                "
                style={{ "--brand": "#26a65b" }}
              >
                <span
                  aria-hidden
                  className="absolute -z-10 -inset-x-6 -inset-y-2 blur-2xl opacity-20 rounded-full"
                  style={{ background: "radial-gradient(60% 60% at 30% 50%, var(--brand) 0%, transparent 70%)" }}
                />
                <span
                  aria-hidden
                  className="grid h-9 w-9 place-items-center rounded-xl ring-1 ring-black/5 dark:ring-white/10 transition-transform duration-300 hover:rotate-3"
                  style={{ background: "conic-gradient(from 160deg, #26a65b22, transparent 55%)" }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M12 2.5l1.2 5.7 5.8 1.2-5.8 1.2-1.2 5.8-1.2-5.8-5.8-1.2 5.8-1.2L12 2.5z"
                      fill="none"
                      stroke="#26a65b"
                      strokeWidth="1.8"
                      strokeLinejoin="round"
                    />
                    <circle cx="12" cy="12" r="1.6" fill="#26a65b" />
                  </svg>
                </span>
                <span
                  className="bg-clip-text text-transparent"
                  style={{
                    backgroundImage:
                      "linear-gradient(92deg, #26a65b 0%, #1f8f4f 55%, #26a65b 100%)",
                  }}
                >
                  {pageTitle}
                </span>
                <span
                  aria-hidden
                  className="absolute left-[3.75rem] -bottom-2 h-[3px] w-24 rounded-full"
                  style={{
                    background:
                      "linear-gradient(90deg, transparent, #26a65b 25%, #26a65b, transparent 90%)",
                  }}
                />
              </h1>
            </div>

            <div className="flex-1 min-w-0">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                }}
                className="relative"
              >
                <div className="flex items-center gap-2 rounded-full bg-white dark:bg-gray-800 px-4 py-3 shadow-sm ring-1 ring-green-600 dark:ring-green-500 w-full">
                  <Search className="w-5 h-5 text-green-500 flex-shrink-0" aria-hidden />
                  <Input
                    placeholder="Search gift cards..."
                    className="w-full min-w-0 bg-transparent border-none focus-visible:ring-0 focus-visible:ring-offset-0 p-0 text-base placeholder:text-gray-500"
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    aria-label="Search gift cards"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => {
                        setSearchQuery("");
                        setSubmittedQuery("");
                        setSelectedCategoryId(null);
                        setCategoryName("");
                      }}
                      className="p-1 text-gray-400 hover:text-gray-600 flex-shrink-0"
                      aria-label="Clear search"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  )}
                </div>
              </form>
            </div>

            <div className="flex items-center gap-3 flex-shrink-0">
              <span className="text-sm text-gray-600 dark:text-gray-400 hidden md:inline">Sort:</span>

              <div className="relative">
                <button
                  type="button"
                  onClick={() => setSortMenuOpen(!sortMenuOpen)}
                  className="flex items-center gap-2 px-4 py-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg shadow-sm hover:shadow-md transition-all min-w-[140px]"
                >
                  <span className="text-sm font-medium">
                    {sortBy === "paramotorDiscount"
                      ? "Best Discount"
                      : sortBy === "newest"
                        ? "Newest"
                        : sortBy === "oldest"
                          ? "Oldest"
                          : sortBy === "name"
                            ? "Name"
                            : "Default"}
                  </span>
                  <ChevronDown className={`h-4 w-4 transition-transform ${sortMenuOpen ? "rotate-180" : ""}`} />
                </button>

                {sortMenuOpen && (
                  <div className="absolute right-0 top-full mt-2 w-48 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg shadow-lg z-50">
                    <div className="py-1">
                      {[
                        { value: undefined, label: "Default" },
                        { value: "paramotorDiscount", label: "Best Discount" },
                        { value: "newest", label: "Newest" },
                        { value: "oldest", label: "Oldest" },
                        { value: "name", label: "Name A-Z" },
                      ].map(option => (
                        <button
                          key={option.label}
                          onClick={() => {
                            setSortBy(option.value as any);
                            setSortMenuOpen(false);
                          }}
                          className={cn(
                            "w-full text-left px-4 py-2 text-sm transition-colors",
                            sortBy === option.value
                              ? "bg-green-50 text-green-700 font-semibold"
                              : "text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700",
                          )}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {(sortBy === "paramotorDiscount" || sortBy === "name") && (
                <button
                  type="button"
                  onClick={() => setSortDirection(prev => prev === "asc" ? "desc" : "asc")}
                  className="px-3 py-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                  title={`Sort ${sortDirection === "asc" ? "descending" : "ascending"}`}
                >
                  <ChevronUp className={`h-4 w-4 transition-transform ${sortDirection === "asc" ? "rotate-0" : "rotate-180"}`} />
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-4 md:gap-6">
          {displayedCards.map((card) => {
            let displayDescription: React.ReactNode;

            if (card.paramotorDiscount && card.paramotorDiscount > 0) {
              displayDescription = (
                <span>
                  <span className="text-rose-600 font-semibold">
                    Flat
                    {" "}
                    {card.paramotorDiscount}
                    % OFF
                  </span>
                  {" — Grab the Deal Today!"}
                </span>
              );
            } else {
              displayDescription = card.description ?? "";
            }

            return (
              <GiftCardItem
                key={card.sku}
                giftCard={{ ...card, description: displayDescription as any }}
              />
            );
          })}

          {isLoading && page === 0 && (
            <>
              {Array.from({ length: 12 }).map((_, index) => (
                <GiftCardShimmer key={`shimmer-${index}`} />
              ))}
            </>
          )}
        </div>

        {/* Loading spinner for subsequent pages */}
        {isLoadingMore && (
          <div className="flex justify-center mt-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-600" aria-label="Loading more items"></div>
          </div>
        )}

        {/* Load More Button */}
        {hasMore && !isLoading && !isLoadingMore && (
          <div className="flex flex-col items-center mt-8 gap-4">
            <Button
              onClick={handleLoadMore}
              className="px-8 py-3 bg-green-600 hover:bg-green-700 text-white font-medium rounded-lg transition-colors"
            >
              Load More Gift Cards
            </Button>
            
            {/* Toggle between infinite scroll and load more */}
            <button
              onClick={toggleScrollMode}
              className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 underline"
            >
              {useInfiniteScroll ? "Switch to Load More Button" : "Switch to Auto Load"}
            </button>
          </div>
        )}

        {/* Infinite scroll trigger */}
        {hasMore && !isLoading && !isLoadingMore && useInfiniteScroll && (
          <div ref={observerTarget} className="h-4 mt-8" />
        )}

        {displayedCards.length === 0 && !isLoading && (
          <div className="text-center py-16">
            <div className="max-w-sm mx-auto">
              <div className="w-20 h-20 mx-auto mb-4 bg-gray-100 dark:bg-gray-800 rounded-full flex items-center justify-center">
                <svg className="w-10 h-10 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                </svg>
              </div>
              <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
                No gift cards found
              </h3>
              <p className="text-gray-600 dark:text-gray-400 mb-4">
                {categoryName
                  ? `No gift cards available in ${categoryName} category right now.`
                  : "No gift cards available right now."}
              </p>
            </div>
          </div>
        )}
      </div>
    </ConsumerLayout>
  );
};

export default GiftCardFilterPage;