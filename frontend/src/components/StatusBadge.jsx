const LABELS = { active: 'Active', inactive: 'Deactivated', expired: 'Expired' };

// status comes from the API: 'active' | 'inactive' | 'expired'
export default function StatusBadge({ status }) {
  return <span className={`badge ${status}`}>{LABELS[status] ?? status}</span>;
}
