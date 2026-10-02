const DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// The API only returns days that had clicks, e.g. [{ date: '2026-10-02', clicks: 3 }].
// Fill in the missing days with 0 so the chart shows all 30 days evenly.
// Dates are UTC days, because the database groups clicks by UTC day.
function last30Days(clicksByDay) {
  const counts = new Map(clicksByDay.map((d) => [d.date, d.clicks]));
  const days = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const date = new Date(Date.now() - i * DAY_MS).toISOString().slice(0, 10);
    days.push({ date, clicks: counts.get(date) ?? 0 });
  }
  return days;
}

const shortDate = (date) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

// A simple column chart built from divs: each bar's height is its share of the busiest day.
export default function ClicksChart({ clicksByDay }) {
  const days = last30Days(clicksByDay);
  const max = Math.max(1, ...days.map((d) => d.clicks));

  return (
    <figure className="chart">
      <figcaption>Clicks per day, last 30 days (UTC)</figcaption>
      <div className="chart-body">
        <div className="chart-axis">
          <span>{max}</span>
          <span>0</span>
        </div>
        <div className="chart-plot">
          {days.map((d) => (
            <div key={d.date} className="chart-col" aria-label={`${shortDate(d.date)}: ${d.clicks} clicks`}>
              {d.clicks > 0 && <div className="chart-bar" style={{ height: `${(d.clicks / max) * 100}%` }} />}
              <div className="chart-tip">
                <strong>{d.clicks}</strong> {d.clicks === 1 ? 'click' : 'clicks'}
                <br />
                {shortDate(d.date)}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="chart-dates muted">
        <span>{shortDate(days[0].date)}</span>
        <span>{shortDate(days[DAYS - 1].date)}</span>
      </div>

      {/* The same numbers as a table, for screen readers and exact values. */}
      <details>
        <summary className="muted">Show as table</summary>
        <table>
          <tbody>
            {days
              .filter((d) => d.clicks > 0)
              .map((d) => (
                <tr key={d.date}>
                  <td>{shortDate(d.date)}</td>
                  <td className="num">{d.clicks}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
