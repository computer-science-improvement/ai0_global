export function Pagination({ page, pageSize, total, onPage }: {
  page: number; pageSize: number; total: number; onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="mt-4 flex items-center justify-between text-sm">
      <span className="text-neutral-400">{total} items · page {page} of {pages}</span>
      <div className="flex gap-2">
        <button disabled={page <= 1} onClick={() => onPage(page - 1)}
          className="rounded bg-neutral-800 px-3 py-1 disabled:opacity-30">Prev</button>
        <button disabled={page >= pages} onClick={() => onPage(page + 1)}
          className="rounded bg-neutral-800 px-3 py-1 disabled:opacity-30">Next</button>
      </div>
    </div>
  );
}
