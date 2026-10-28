/** Prev / Next under a list: "40 items · page 2 of 4" on the left, two bordered buttons on the right. Hidden for one page. */
export function Pagination({ page, pageSize, total, onPage }: {
  page: number; pageSize: number; total: number; onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="mt-6 flex items-center justify-between text-[13px]">
      <span className="tabular-nums" style={{ color: 'var(--color-ink-muted)' }}>
        {total} items · page {page} of {pages}
      </span>
      <div className="flex gap-2">
        <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)} className="btn-secondary btn-sm">
          Prev
        </button>
        <button type="button" disabled={page >= pages} onClick={() => onPage(page + 1)} className="btn-secondary btn-sm">
          Next
        </button>
      </div>
    </div>
  );
}
