import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api.js';
import CopyButton from '../components/CopyButton.jsx';
import ErrorMessage from '../components/ErrorMessage.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import { formatDate, toIsoDate } from '../dates.js';

const PAGE_SIZE = 10;

export default function Dashboard() {
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null); // { urls, pagination } from the API
  const [error, setError] = useState(null);
  const [reloadCount, setReloadCount] = useState(0); // bumped to fetch the list again

  // Load the current page of links whenever the page number changes (or after a new link).
  useEffect(() => {
    let ignore = false; // if the user changes page quickly, ignore the older response
    api
      .listUrls(page, PAGE_SIZE)
      .then((result) => !ignore && setData(result))
      .catch((err) => !ignore && setError(err));
    return () => {
      ignore = true;
    };
  }, [page, reloadCount]);

  function handleCreated() {
    setPage(1); // the new link is the newest, so it's first on page 1
    setReloadCount((n) => n + 1);
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.pagination.total / PAGE_SIZE)) : 1;

  return (
    <>
      <CreateLinkForm onCreated={handleCreated} />

      <section className="card">
        <h2>Your links</h2>
        <ErrorMessage error={error} />
        {!data && !error && <p className="muted">Loading…</p>}
        {data?.urls.length === 0 && <p className="muted">No links yet. Create your first one above.</p>}

        {data?.urls.length > 0 && (
          <>
            <ul className="link-list">
              {data.urls.map((url) => (
                <li key={url.id}>
                  <div className="link-main">
                    <div className="row">
                      <a href={url.shortUrl} target="_blank" rel="noreferrer" className="short-url">
                        {url.shortUrl}
                      </a>
                      <StatusBadge status={url.status} />
                    </div>
                    <div className="muted truncate" title={url.originalUrl}>
                      {url.originalUrl}
                    </div>
                    <small className="muted">Created {formatDate(url.createdAt)}</small>
                  </div>
                  <div className="row">
                    <CopyButton text={url.shortUrl} />
                    <Link to={`/links/${url.id}`} className="button secondary small">
                      Details
                    </Link>
                  </div>
                </li>
              ))}
            </ul>

            <div className="pagination">
              <button className="secondary small" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                Previous
              </button>
              <span className="muted">
                Page {page} of {totalPages}
              </span>
              <button className="secondary small" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
                Next
              </button>
            </div>
          </>
        )}
      </section>
    </>
  );
}

function CreateLinkForm({ onCreated }) {
  const [url, setUrl] = useState('');
  const [customAlias, setCustomAlias] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [created, setCreated] = useState(null); // the link we just made, shown under the form
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setCreated(null);
    setSubmitting(true);
    try {
      // Optional fields are left out when empty (the API rejects an empty alias).
      const result = await api.createUrl({
        url,
        customAlias: customAlias || undefined,
        expiresAt: toIsoDate(expiresAt) ?? undefined,
      });
      setCreated(result.url);
      setUrl('');
      setCustomAlias('');
      setExpiresAt('');
      onCreated();
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card" onSubmit={handleSubmit}>
      <h2>Shorten a link</h2>
      <label>
        Long URL
        <input
          type="url"
          placeholder="https://example.com/a/very/long/page"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
        />
      </label>
      <div className="grid-2">
        <label>
          Custom alias <span className="muted">(optional)</span>
          <input
            placeholder="my-link"
            value={customAlias}
            onChange={(e) => setCustomAlias(e.target.value)}
            pattern="[A-Za-z0-9_\-]{3,32}"
            title="3-32 letters, numbers, - or _"
          />
        </label>
        <label>
          Expires <span className="muted">(optional)</span>
          <input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
        </label>
      </div>

      <ErrorMessage error={error} />
      <button type="submit" disabled={submitting}>
        {submitting ? 'Creating…' : 'Shorten'}
      </button>

      {created && (
        <div className="success row">
          <span>
            Your short link: <a href={created.shortUrl} target="_blank" rel="noreferrer">{created.shortUrl}</a>
          </span>
          <CopyButton text={created.shortUrl} />
        </div>
      )}
    </form>
  );
}
