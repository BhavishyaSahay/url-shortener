import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '../api.js';
import ClicksChart from '../components/ClicksChart.jsx';
import CopyButton from '../components/CopyButton.jsx';
import ErrorMessage from '../components/ErrorMessage.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import { formatDate, toInputValue, toIsoDate } from '../dates.js';

export default function LinkDetails() {
  const { id } = useParams(); // from the URL: /links/:id
  const navigate = useNavigate();
  const [url, setUrl] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let ignore = false;
    Promise.all([api.getUrl(id), api.getAnalytics(id)])
      .then(([urlData, stats]) => {
        if (ignore) return;
        setUrl(urlData.url);
        setAnalytics(stats);
      })
      .catch((err) => !ignore && setError(err));
    return () => {
      ignore = true;
    };
  }, [id]);

  async function run(action) {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err);
    }
  }

  const toggleActive = () => run(async () => setUrl((await api.updateUrl(id, { isActive: !url.isActive })).url));
  const refreshAnalytics = () => run(async () => setAnalytics(await api.getAnalytics(id)));
  const remove = () =>
    run(async () => {
      if (!window.confirm('Delete this link and all its click data? This cannot be undone.')) return;
      await api.deleteUrl(id);
      navigate('/');
    });

  if (!url) {
    return (
      <section className="card">
        <Link to="/" className="back">← All links</Link>
        {error ? <ErrorMessage error={error} /> : <p className="muted">Loading…</p>}
      </section>
    );
  }

  return (
    <>
      <section className="card">
        <Link to="/" className="back">← All links</Link>
        <div className="row spread">
          <h1 className="row">
            <a href={url.shortUrl} target="_blank" rel="noreferrer">
              {url.shortUrl}
            </a>
            <StatusBadge status={url.status} />
          </h1>
          <CopyButton text={url.shortUrl} />
        </div>
        <p className="muted">
          Created {formatDate(url.createdAt)}
          {url.expiresAt && ` · Expires ${formatDate(url.expiresAt)}`}
          {url.isCustomAlias && ' · Custom alias'}
        </p>

        <ErrorMessage error={error} />
        <EditLinkForm key={url.id} url={url} onSaved={setUrl} />

        <div className="row actions">
          <button className="secondary" onClick={toggleActive}>
            {url.isActive ? 'Deactivate' : 'Activate'}
          </button>
          <button className="danger" onClick={remove}>
            Delete
          </button>
        </div>
      </section>

      <section className="card">
        <div className="row spread">
          <h2>Analytics</h2>
          <button className="secondary small" onClick={refreshAnalytics}>
            Refresh
          </button>
        </div>
        <p className="muted">Clicks are recorded by a background worker, so new ones can take a moment to appear.</p>

        <div className="stat">
          <span className="stat-value">{analytics.totalClicks.toLocaleString()}</span>
          <span className="muted">total clicks</span>
        </div>

        <ClicksChart clicksByDay={analytics.clicksByDay} />

        <div className="grid-2">
          <CountTable title="Top referrers" rows={analytics.topReferrers} labelKey="referrer" />
          <CountTable title="Browsers (user agents)" rows={analytics.userAgents} labelKey="userAgent" />
        </div>
      </section>
    </>
  );
}

// Change the destination or the expiry. Only fields that changed are sent: an
// expired link's old date is in the past, and the API rejects past dates.
function EditLinkForm({ url, onSaved }) {
  const [originalUrl, setOriginalUrl] = useState(url.originalUrl);
  const [expiresAt, setExpiresAt] = useState(toInputValue(url.expiresAt));
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setSaved(false);

    const changes = {};
    if (originalUrl !== url.originalUrl) changes.url = originalUrl;
    if (expiresAt !== toInputValue(url.expiresAt)) changes.expiresAt = toIsoDate(expiresAt); // null removes it
    if (Object.keys(changes).length === 0) return;

    try {
      onSaved((await api.updateUrl(url.id, changes)).url);
      setSaved(true);
    } catch (err) {
      setError(err);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <label>
        Destination URL
        <input type="url" value={originalUrl} onChange={(e) => setOriginalUrl(e.target.value)} required />
      </label>
      <label>
        Expires <span className="muted">(leave empty for never)</span>
        <input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
      </label>
      <ErrorMessage error={error} />
      <div className="row">
        <button type="submit">Save changes</button>
        {saved && <span className="muted">Saved</span>}
      </div>
    </form>
  );
}

function CountTable({ title, rows, labelKey }) {
  return (
    <div>
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <p className="muted">No clicks yet.</p>
      ) : (
        <table>
          <tbody>
            {rows.map((row) => (
              <tr key={row[labelKey]}>
                <td className="truncate" title={row[labelKey]}>
                  {row[labelKey]}
                </td>
                <td className="num">{row.clicks.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
