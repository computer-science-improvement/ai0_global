import { Link } from '@tanstack/react-router';
import { Icon } from '../ui/Icon';
import { useBudgets } from '../../api/spend';
import { barPct, budgetBadge, budgetBarColor, fmtUsd } from '../../lib/spend';
import { useAuth } from '../../auth/use-auth';
import { initials, pickGlobalBudget } from '../../nav/sidebar-model';

/**
 * Spec 078: the sidebar footer. The AI budget card shows today's spend of the global
 * budget (the same row the network map uses) and opens Spend → Budgets; the operator
 * row shows who is signed in, with Log out (moved here from the top bar). Both are
 * shown in the expanded sidebar and the drawer; the icon rail keeps only the avatar
 * and Log out.
 *
 * The card draws its own meter from the Spend helpers instead of BudgetBar: BudgetBar's
 * header (label, state badge and amounts on one row) does not fit the 192px the card has.
 * The state shows as the bar color and in the tooltip.
 */
export function BudgetCard({ onNavigate }: { onNavigate?: () => void }) {
  const q = useBudgets();
  // Nothing while loading or when the budgets cannot be read: the card is a convenience.
  if (!q.data) return null;
  const row = pickGlobalBudget(q.data.rows);
  const badge = row ? budgetBadge(row.state, row.enforce) : null;
  return (
    <Link to="/app/spend" search={{ tab: 'budgets' }} className="side-budget" onClick={onNavigate}
      title={row ? `AI budget today${badge ? `: ${badge.label}` : ''}. Open the budgets.` : 'No AI budget is set. Open the budgets.'}>
      <div className="side-budget-head text-micro">
        <span className="side-budget-label">AI budget today</span>
        {row ? (
          <span className="side-budget-amount tabular-nums">
            {fmtUsd(row.spentTodayUsd)} <span className="side-budget-cap">/ {row.dailyUsd == null ? 'no daily cap' : fmtUsd(row.dailyUsd)}</span>
          </span>
        ) : (
          <span className="side-budget-cap">No budget set</span>
        )}
      </div>
      {row && (
        <div className="side-budget-bar" role="meter" aria-label="AI budget today" aria-valuemin={0}
          aria-valuemax={row.dailyUsd ?? 0} aria-valuenow={row.spentTodayUsd}>
          <div style={{ width: `${barPct(row.spentTodayUsd, row.dailyUsd)}%`, background: budgetBarColor(row.state) }} />
        </div>
      )}
    </Link>
  );
}

export function OperatorRow({ collapsed, onLogout, onEditMenu }: {
  collapsed: boolean;
  /** Absent when there is no session to end (the dev-bypass identity): no Log out button. */
  onLogout?: () => void;
  onEditMenu: () => void;
}) {
  const { me } = useAuth();
  const name = me ? me.firstName || 'Operator' : '';
  const handle = me?.username ? `@${me.username}` : null;
  const edit = (
    <button type="button" className="btn-icon side-tool" style={{ width: 32, height: 32 }}
      aria-label="Edit menu" title="Edit menu" onClick={onEditMenu}>
      <Icon name="pencil" size={15} />
    </button>
  );
  const logout = onLogout && (
    <button type="button" className="btn-icon side-tool" style={{ width: 32, height: 32 }}
      aria-label="Log out" title="Log out" onClick={onLogout}>
      <Icon name="logout" size={16} />
    </button>
  );
  if (collapsed) {
    return (
      <div className="side-op side-op-rail">
        {me && (
          <span className="side-av" title={handle ? `${name} (${handle})` : name} role="img" aria-label={handle ? `${name}, ${handle}` : name}>
            {initials(name)}
          </span>
        )}
        {edit}
        {logout}
      </div>
    );
  }
  return (
    <div className="side-op">
      {me ? (
        <>
          <span className="side-av" aria-hidden>{initials(name)}</span>
          <div className="side-op-text">
            <div className="side-op-name" title={name}>{name}</div>
            {handle && <div className="side-op-user" title={handle}>{handle}</div>}
          </div>
        </>
      ) : <span className="side-op-text" />}
      {edit}
      {logout}
    </div>
  );
}
