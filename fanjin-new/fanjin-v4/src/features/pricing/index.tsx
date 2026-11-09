import { useState, useMemo, useEffect } from "react";
import { getPricing } from "./api";
import { PricingTable } from "./components/PricingTable";
import type { TokenUnit, PricingData } from "./types";

export function PricingPage() {
  const [searchInput, setSearchInput] = useState("");
  const [tokenUnit, setTokenUnit] = useState<TokenUnit>("M");
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [vendorFilter, setVendorFilter] = useState<string | null>(null);
  const [data, setData] = useState<PricingData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let mounted = true;
    
    getPricing()
      .then((result) => {
        if (mounted) {
          setData(result);
          setIsLoading(false);
        }
      })
      .catch((err) => {
        if (mounted) {
          setError(err);
          setIsLoading(false);
        }
      });
    
    return () => {
      mounted = false;
    };
  }, []);

  const filteredModels = useMemo(() => {
    if (!data?.data) return [];

    let filtered = [...data.data];

    // 搜索过滤
    if (searchInput) {
      const search = searchInput.toLowerCase();
      filtered = filtered.filter(
        (model) =>
          model.model_name.toLowerCase().includes(search) ||
          model.name.toLowerCase().includes(search) ||
          model.vendor_name?.toLowerCase().includes(search) ||
          model.category.toLowerCase().includes(search)
      );
    }

    // 类别过滤
    if (categoryFilter) {
      filtered = filtered.filter((model) => model.category === categoryFilter);
    }

    // 供应商过滤
    if (vendorFilter) {
      filtered = filtered.filter((model) => model.vendor_name === vendorFilter);
    }

    return filtered;
  }, [data?.data, searchInput, categoryFilter, vendorFilter]);

  const categories = useMemo(() => {
    if (!data?.data) return [];
    const cats = new Set(data.data.map((m) => m.category));
    return Array.from(cats);
  }, [data?.data]);

  const vendors = useMemo(() => {
    if (!data?.vendors) return [];
    return data.vendors;
  }, [data?.vendors]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[var(--cui-background)] flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-[var(--cui-primary)] border-r-transparent"></div>
          <p className="mt-4 text-sm text-[var(--cui-text-muted)]">加载中...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-[var(--cui-background)] flex items-center justify-center">
        <div className="text-center">
          <p className="text-sm text-red-600 dark:text-red-400">加载失败，请稍后重试</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--cui-background)]">
      <div className="mx-auto max-w-[1800px] px-4 py-8 sm:px-6 lg:px-8">
        {/* Header */}
        <header className="mb-8 text-center">
          <h1 className="text-4xl font-bold text-[var(--cui-text)] mb-3">
            模型价格广场
          </h1>
          <p className="text-[var(--cui-text-muted)] mb-2">
            当前共有 <span className="font-semibold text-[var(--cui-primary)]">{data?.data?.length || 0}</span> 个模型可用
          </p>
          <p className="text-sm text-[var(--cui-text-muted)] max-w-2xl mx-auto">
            探索精选的 AI 模型，对比价格和能力，为每个场景选择合适的模型
          </p>
        </header>

        {/* Search and Filters */}
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex-1 max-w-md">
            <input
              type="text"
              placeholder="搜索模型名称、供应商、类型..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="w-full rounded-lg border border-[var(--cui-border)] bg-[var(--cui-surface)] px-4 py-2 text-sm text-[var(--cui-text)] placeholder:text-[var(--cui-text-muted)] focus:border-[var(--cui-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--cui-primary)]/20"
            />
          </div>

          <div className="flex flex-wrap gap-2">
            {/* Category Filter */}
            <select
              value={categoryFilter || ""}
              onChange={(e) => setCategoryFilter(e.target.value || null)}
              className="rounded-lg border border-[var(--cui-border)] bg-[var(--cui-surface)] px-3 py-2 text-sm text-[var(--cui-text)] focus:border-[var(--cui-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--cui-primary)]/20"
            >
              <option value="">全部类别</option>
              {categories.map((cat: string) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>

            {/* Vendor Filter */}
            <select
              value={vendorFilter || ""}
              onChange={(e) => setVendorFilter(e.target.value || null)}
              className="rounded-lg border border-[var(--cui-border)] bg-[var(--cui-surface)] px-3 py-2 text-sm text-[var(--cui-text)] focus:border-[var(--cui-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--cui-primary)]/20"
            >
              <option value="">全部供应商</option>
              {vendors.map((vendor) => (
                <option key={vendor.id} value={vendor.name}>
                  {vendor.name}
                </option>
              ))}
            </select>

            {/* Token Unit Toggle */}
            <div className="flex items-center gap-1 rounded-lg border border-[var(--cui-border)] bg-[var(--cui-surface)] p-1">
              <button
                onClick={() => setTokenUnit("M")}
                className={`rounded px-3 py-1 text-sm font-medium transition-colors ${
                  tokenUnit === "M"
                    ? "bg-[var(--cui-primary)] text-white"
                    : "text-[var(--cui-text-muted)] hover:text-[var(--cui-text)]"
                }`}
              >
                1M
              </button>
              <button
                onClick={() => setTokenUnit("K")}
                className={`rounded px-3 py-1 text-sm font-medium transition-colors ${
                  tokenUnit === "K"
                    ? "bg-[var(--cui-primary)] text-white"
                    : "text-[var(--cui-text-muted)] hover:text-[var(--cui-text)]"
                }`}
              >
                1K
              </button>
            </div>
          </div>
        </div>

        {/* Results Count */}
        <div className="mb-4 flex items-center justify-between">
          <p className="text-sm text-[var(--cui-text-muted)]">
            显示 <span className="font-semibold text-[var(--cui-text)]">{filteredModels.length}</span> 个结果
          </p>
          {(searchInput || categoryFilter || vendorFilter) && (
            <button
              onClick={() => {
                setSearchInput("");
                setCategoryFilter(null);
                setVendorFilter(null);
              }}
              className="text-sm text-[var(--cui-primary)] hover:underline"
            >
              清除筛选
            </button>
          )}
        </div>

        {/* Pricing Table */}
        <PricingTable models={filteredModels} tokenUnit={tokenUnit} />
      </div>
    </div>
  );
}
