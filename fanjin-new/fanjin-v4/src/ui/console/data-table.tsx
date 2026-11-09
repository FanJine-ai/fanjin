import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  AlertCircle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsUpDown,
  Columns3,
  RotateCcw,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { Checkbox } from "./selection";
import "./data.css";

export type ColumnPriority = "primary" | "secondary" | "detail";
export type SortDirection = "ascending" | "descending";
export type SortValue = string | number | boolean | Date | null | undefined;
export type DataTableControlVisibility = "auto" | "always" | "hidden";
export type DataTableScrollMode = "auto" | "contained" | "page";

export interface DataTableSort {
  columnId: string;
  direction: SortDirection;
}

export interface DataTableColumn<Row> {
  id: string;
  header: ReactNode;
  headerLabel?: string;
  accessor?: keyof Row | ((row: Row) => ReactNode);
  cell?: (row: Row, rowIndex: number) => ReactNode;
  sortValue?: (row: Row) => SortValue;
  sortable?: boolean;
  priority?: ColumnPriority;
  hideable?: boolean;
  defaultVisible?: boolean;
  align?: "start" | "center" | "end";
  width?: string;
  minWidth?: string;
  className?: string;
}

export interface DataTableProps<Row> {
  columns: DataTableColumn<Row>[];
  rows: Row[];
  getRowId: (row: Row, rowIndex: number) => string | number;
  caption?: ReactNode;
  captionMode?: "visible" | "sr-only";
  ariaLabel?: string;
  className?: string;
  loading?: boolean;
  skeletonRowCount?: number;
  renderSkeletonCell?: (column: DataTableColumn<Row>, rowIndex: number) => ReactNode;
  emptyState?: ReactNode;
  error?: ReactNode;
  onRetry?: () => void;
  onRowClick?: (row: Row, rowIndex: number) => void;
  getRowAriaLabel?: (row: Row, rowIndex: number) => string;
  sort?: DataTableSort | null;
  defaultSort?: DataTableSort | null;
  onSortChange?: (sort: DataTableSort | null) => void;
  manualSorting?: boolean;
  visibleColumnIds?: string[];
  defaultVisibleColumnIds?: string[];
  onVisibleColumnIdsChange?: (columnIds: string[]) => void;
  columnVisibilityLabel?: string;
  columnTools?: DataTableControlVisibility;
  page?: number;
  defaultPage?: number;
  pageSize?: number;
  defaultPageSize?: number;
  pageSizeOptions?: number[];
  totalRows?: number;
  manualPagination?: boolean;
  onPageChange?: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  paginationLabel?: string;
  pagination?: DataTableControlVisibility;
  scrollMode?: DataTableScrollMode;
}

const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

function compareValues(left: SortValue, right: SortValue) {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  if (left instanceof Date && right instanceof Date) return left.getTime() - right.getTime();
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right);
  return collator.compare(String(left), String(right));
}

function readCell<Row>(column: DataTableColumn<Row>, row: Row, rowIndex: number): ReactNode {
  if (column.cell) return column.cell(row, rowIndex);
  if (typeof column.accessor === "function") return column.accessor(row);
  if (column.accessor != null) return row[column.accessor] as ReactNode;
  return null;
}

function readSortValue<Row>(column: DataTableColumn<Row>, row: Row): SortValue {
  if (column.sortValue) return column.sortValue(row);
  if (typeof column.accessor !== "function" && column.accessor != null) {
    const value = row[column.accessor];
    if (
      value == null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value instanceof Date
    ) {
      return value as SortValue;
    }
  }
  return undefined;
}

function columnStyle<Row>(column: DataTableColumn<Row>): CSSProperties {
  return { width: column.width, minWidth: column.minWidth };
}

export function DataTable<Row>({
  columns,
  rows,
  getRowId,
  caption,
  captionMode = "sr-only",
  ariaLabel = "数据表格",
  className,
  loading = false,
  skeletonRowCount = 6,
  renderSkeletonCell,
  emptyState,
  error,
  onRetry,
  onRowClick,
  getRowAriaLabel,
  sort,
  defaultSort = null,
  onSortChange,
  manualSorting = false,
  visibleColumnIds,
  defaultVisibleColumnIds,
  onVisibleColumnIdsChange,
  columnVisibilityLabel = "显示列",
  columnTools = "auto",
  page,
  defaultPage = 1,
  pageSize,
  defaultPageSize = 20,
  pageSizeOptions = [20, 50, 100],
  totalRows,
  manualPagination = false,
  onPageChange,
  onPageSizeChange,
  paginationLabel = "表格分页",
  pagination = "auto",
  scrollMode = "auto",
}: DataTableProps<Row>) {
  const initialVisibleIds = useMemo(
    () =>
      defaultVisibleColumnIds ??
      columns.filter((column) => column.defaultVisible !== false).map((column) => column.id),
    [columns, defaultVisibleColumnIds],
  );
  const [internalVisibleIds, setInternalVisibleIds] = useState(initialVisibleIds);
  const [internalSort, setInternalSort] = useState<DataTableSort | null>(defaultSort);
  const [internalPage, setInternalPage] = useState(defaultPage);
  const [internalPageSize, setInternalPageSize] = useState(defaultPageSize);
  const onPageChangeRef = useRef(onPageChange);
  const lastNormalizedPageRef = useRef<string | null>(null);

  const activeVisibleIds = visibleColumnIds ?? internalVisibleIds;
  const activeSort = sort === undefined ? internalSort : sort;
  const activePageSize = pageSize ?? internalPageSize;
  const activePage = page ?? internalPage;
  const visibleColumns = columns.filter((column) => activeVisibleIds.includes(column.id));
  const hideableColumns = columns.filter((column) => column.hideable !== false);
  const hasColumnVisibilityState =
    visibleColumnIds !== undefined
    || defaultVisibleColumnIds !== undefined
    || onVisibleColumnIdsChange !== undefined
    || columns.some((column) => column.defaultVisible === false);
  const columnToolsAreUseful =
    hideableColumns.length > 0
    && (hasColumnVisibilityState || (columns.length >= 6 && hideableColumns.length >= 2));
  const showColumnTools = columnTools === "always" || (columnTools === "auto" && columnToolsAreUseful);
  const sortingControlsEnabled = !manualPagination || manualSorting;

  const sortedRows = useMemo(() => {
    if (manualPagination || manualSorting || !activeSort) return rows;
    const column = columns.find((candidate) => candidate.id === activeSort.columnId);
    if (!column) return rows;
    const direction = activeSort.direction === "ascending" ? 1 : -1;
    return [...rows].sort(
      (left, right) => compareValues(readSortValue(column, left), readSortValue(column, right)) * direction,
    );
  }, [activeSort, columns, manualPagination, manualSorting, rows]);

  const resolvedTotalRows = totalRows ?? rows.length;
  const totalPages = Math.max(1, Math.ceil(resolvedTotalRows / activePageSize));
  const safePage = Math.min(Math.max(activePage, 1), totalPages);
  const firstRow = resolvedTotalRows === 0 ? 0 : (safePage - 1) * activePageSize + 1;
  const lastRow = Math.min(safePage * activePageSize, resolvedTotalRows);
  const showPagination =
    pagination === "always"
    || (pagination === "auto" && (manualPagination || resolvedTotalRows > activePageSize || safePage > 1));
  const displayedRows = useMemo(() => {
    if (manualPagination || totalRows !== undefined) return sortedRows;
    const start = (safePage - 1) * activePageSize;
    return sortedRows.slice(start, start + activePageSize);
  }, [activePageSize, manualPagination, safePage, sortedRows, totalRows]);
  const usesContainedScroll =
    scrollMode === "contained"
    || (scrollMode === "auto" && displayedRows.length > 10);

  useEffect(() => {
    onPageChangeRef.current = onPageChange;
  }, [onPageChange]);

  useEffect(() => {
    if (page === undefined || loading || activePage === safePage) {
      lastNormalizedPageRef.current = null;
      return;
    }

    const normalizationKey = `${activePage}:${safePage}:${totalPages}:${activePageSize}`;
    if (lastNormalizedPageRef.current === normalizationKey) return;
    lastNormalizedPageRef.current = normalizationKey;
    onPageChangeRef.current?.(safePage);
  }, [activePage, activePageSize, loading, page, safePage, totalPages]);

  const updateSort = (column: DataTableColumn<Row>) => {
    if (!column.sortable || !sortingControlsEnabled) return;
    const nextSort: DataTableSort =
      activeSort?.columnId === column.id
        ? {
            columnId: column.id,
            direction: activeSort.direction === "ascending" ? "descending" : "ascending",
          }
        : { columnId: column.id, direction: "ascending" };
    if (sort === undefined) setInternalSort(nextSort);
    onSortChange?.(nextSort);
  };

  const updateVisibleColumns = (columnId: string, checked: boolean) => {
    const next = checked
      ? columns.filter((column) => [...activeVisibleIds, columnId].includes(column.id)).map((column) => column.id)
      : activeVisibleIds.filter((id) => id !== columnId);
    if (next.length === 0) return;
    if (visibleColumnIds === undefined) setInternalVisibleIds(next);
    onVisibleColumnIdsChange?.(next);
  };

  const updatePage = (nextPage: number) => {
    const bounded = Math.min(Math.max(nextPage, 1), totalPages);
    if (page === undefined) setInternalPage(bounded);
    onPageChange?.(bounded);
  };

  const updatePageSize = (nextPageSize: number) => {
    if (pageSize === undefined) setInternalPageSize(nextPageSize);
    if (page === undefined) setInternalPage(1);
    onPageSizeChange?.(nextPageSize);
    // Controlled consumers update page and page size atomically (typically in
    // URL state) inside onPageSizeChange. Calling onPageChange immediately
    // afterwards would write the stale size back and can race the first update.
    if (!onPageSizeChange) onPageChange?.(1);
  };

  const handleRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, row: Row, rowIndex: number) => {
    if (
      !onRowClick ||
      event.target !== event.currentTarget ||
      (event.key !== "Enter" && event.key !== " ")
    ) {
      return;
    }
    event.preventDefault();
    onRowClick(row, rowIndex);
  };

  const handleRowClick = (event: MouseEvent<HTMLTableRowElement>, row: Row, rowIndex: number) => {
    if (!onRowClick) return;
    const target = event.target as HTMLElement;
    if (
      target !== event.currentTarget
      && target.closest("a, button, input, select, textarea, [role='menuitem'], [role='checkbox'], [role='radio'], [role='option']")
    ) {
      return;
    }
    onRowClick(row, rowIndex);
  };

  const tableCaption = caption ?? ariaLabel;

  return (
    <section className={["consoleDataTable", className].filter(Boolean).join(" ")}>
      {showColumnTools && (
        <div className="consoleDataTable__tools">
          <Popover>
            <PopoverTrigger
              className="consoleDataTable__columnPickerTrigger"
              aria-label={columnVisibilityLabel}
              title={columnVisibilityLabel}
            >
              <Columns3 aria-hidden="true" size={17} />
              <span>{columnVisibilityLabel}</span>
              <ChevronDown className="consoleDataTable__columnPickerChevron" aria-hidden="true" size={15} />
            </PopoverTrigger>
            <PopoverContent className="consoleDataTable__columnPickerContent" align="end">
              <fieldset>
                <legend>{columnVisibilityLabel}</legend>
                {hideableColumns.map((column) => {
                  const checked = activeVisibleIds.includes(column.id);
                  const accessibleLabel = column.headerLabel ?? (typeof column.header === "string" ? column.header : column.id);
                  return (
                    <label key={column.id}>
                      <Checkbox
                        aria-label={accessibleLabel}
                        checked={checked}
                        disabled={checked && activeVisibleIds.length === 1}
                        onCheckedChange={(nextChecked) => updateVisibleColumns(column.id, nextChecked)}
                      />
                      <span>{column.headerLabel ?? column.header}</span>
                    </label>
                  );
                })}
              </fieldset>
            </PopoverContent>
          </Popover>
        </div>
      )}

      <div
        className="consoleDataTable__viewport"
        data-scrollable={usesContainedScroll || undefined}
        data-scroll-mode={scrollMode}
        tabIndex={0}
        aria-label={`${ariaLabel}，可横向滚动`}
      >
        <table aria-label={caption ? ariaLabel : undefined}>
          <caption className={captionMode === "sr-only" ? "consoleSrOnly" : undefined}>
            {tableCaption}
          </caption>
          <thead>
            <tr>
              {visibleColumns.map((column) => {
                const canSortColumn = Boolean(column.sortable && sortingControlsEnabled);
                const ariaSort = activeSort?.columnId === column.id ? activeSort.direction : "none";
                return (
                  <th
                    key={column.id}
                    scope="col"
                    aria-sort={canSortColumn ? ariaSort : undefined}
                    className={[
                      `consoleDataTableColumn--${column.priority ?? "secondary"}`,
                      `consoleDataTableCell--${column.align ?? "start"}`,
                      column.className,
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    style={columnStyle(column)}
                  >
                    {canSortColumn ? (
                      <button type="button" onClick={() => updateSort(column)}>
                        <span>{column.header}</span>
                        {ariaSort === "ascending" ? (
                          <ChevronUp aria-hidden="true" size={15} />
                        ) : ariaSort === "descending" ? (
                          <ChevronDown aria-hidden="true" size={15} />
                        ) : (
                          <ChevronsUpDown aria-hidden="true" size={15} />
                        )}
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody aria-busy={loading || undefined}>
            {loading ? (
              Array.from({ length: skeletonRowCount }, (_, rowIndex) => (
                <tr className="consoleDataTable__skeletonRow" key={`skeleton-${rowIndex}`} aria-hidden="true">
                  {visibleColumns.map((column) => (
                    <td
                      className={`consoleDataTableColumn--${column.priority ?? "secondary"}`}
                      key={column.id}
                      style={columnStyle(column)}
                    >
                      {renderSkeletonCell?.(column, rowIndex) ?? <span className="consoleDataTable__skeleton" />}
                    </td>
                  ))}
                </tr>
              ))
            ) : error ? (
              <tr>
                <td className="consoleDataTable__stateCell" colSpan={Math.max(visibleColumns.length, 1)}>
                  <div className="consoleDataTable__state" role="alert">
                    <AlertCircle aria-hidden="true" size={22} />
                    <div>{error}</div>
                    {onRetry && (
                      <button type="button" onClick={onRetry}>
                        <RotateCcw aria-hidden="true" size={16} />
                        重试
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ) : displayedRows.length === 0 ? (
              <tr>
                <td className="consoleDataTable__stateCell" colSpan={Math.max(visibleColumns.length, 1)}>
                  <div className="consoleDataTable__state">{emptyState ?? "暂无数据"}</div>
                </td>
              </tr>
            ) : (
              displayedRows.map((row, rowIndex) => (
                <tr
                  key={getRowId(row, rowIndex)}
                  className={onRowClick ? "consoleDataTable__clickableRow" : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  aria-label={getRowAriaLabel?.(row, rowIndex)}
                  onClick={onRowClick ? (event) => handleRowClick(event, row, rowIndex) : undefined}
                  onKeyDown={(event) => handleRowKeyDown(event, row, rowIndex)}
                >
                  {visibleColumns.map((column) => (
                    <td
                      key={column.id}
                      className={[
                        `consoleDataTableColumn--${column.priority ?? "secondary"}`,
                        `consoleDataTableCell--${column.align ?? "start"}`,
                        column.className,
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      style={columnStyle(column)}
                    >
                      {readCell(column, row, rowIndex)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {showPagination && (
        <nav className="consoleDataTable__pagination" aria-label={paginationLabel}>
          <label>
            <span>每页</span>
            <select
              aria-label="每页条数"
              value={activePageSize}
              onChange={(event) => updatePageSize(Number(event.target.value))}
            >
              {pageSizeOptions.map((option) => (
                <option key={option} value={option}>
                  {option} 条
                </option>
              ))}
            </select>
          </label>
          <span className="consoleDataTable__range" aria-live="polite">
            {firstRow}–{lastRow} / {resolvedTotalRows}
          </span>
          <div className="consoleDataTable__pageButtons">
            <button
              type="button"
              aria-label="上一页"
              disabled={safePage <= 1}
              onClick={() => updatePage(safePage - 1)}
            >
              <ChevronLeft aria-hidden="true" size={18} />
            </button>
            <span>
              第 {safePage} / {totalPages} 页
            </span>
            <button
              type="button"
              aria-label="下一页"
              disabled={safePage >= totalPages}
              onClick={() => updatePage(safePage + 1)}
            >
              <ChevronRight aria-hidden="true" size={18} />
            </button>
          </div>
        </nav>
      )}
    </section>
  );
}
