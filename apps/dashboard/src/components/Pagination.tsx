export function Pagination({ page, pageSize, total, onPage }: {
  page: number; pageSize: number; total: number; onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="mt-6 flex items-center justify-between text-[13px]">
      <span style={{ color: 'var(--color-ink-muted)' }}>
        {total} items · page {page} of {pages}
      </span>
      <div className="flex gap-2">
        <button disabled={page <= 1} onClick={() => onPage(page - 1)} className="btn-secondary disabled:opacity-30">
          Prev
        </button>
        <button disabled={page >= pages} onClick={() => onPage(page + 1)} className="btn-primary disabled:opacity-30">
          Next
        </button>
      </div>
    </div>
  );
}
