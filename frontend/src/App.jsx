import { useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router';
import { api, setUnauthorizedHandler } from './api.js';
import AuthForm from './pages/AuthForm.jsx';
import Dashboard from './pages/Dashboard.jsx';
import LinkDetails from './pages/LinkDetails.jsx';

export default function App() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true); // true until we know if the user is logged in

  // On first load, ask the backend who we are. The cookie is HTTP-only, so
  // JavaScript can't read it; GET /auth/me is the only way to know.
  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    api
      .me()
      .then((data) => setUser(data.user))
      .catch(() => setUser(null))
      .finally(() => setChecking(false));
  }, []);

  async function logout() {
    await api.logout().catch(() => {});
    setUser(null);
  }

  if (checking) return <p className="page muted">Loading…</p>;

  // Pages that need a login send logged-out users to /login, and the reverse.
  const loggedIn = (page) => (user ? page : <Navigate to="/login" replace />);
  const loggedOut = (page) => (user ? <Navigate to="/" replace /> : page);

  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">
          URL Shortener
        </Link>
        {user && (
          <div className="row">
            <span className="muted">{user.email}</span>
            <button className="secondary" onClick={logout}>
              Log out
            </button>
          </div>
        )}
      </header>

      <main className="page">
        <Routes>
          <Route path="/login" element={loggedOut(<AuthForm key="login" mode="login" onSuccess={setUser} />)} />
          <Route path="/register" element={loggedOut(<AuthForm key="register" mode="register" onSuccess={setUser} />)} />
          <Route path="/" element={loggedIn(<Dashboard />)} />
          <Route path="/links/:id" element={loggedIn(<LinkDetails />)} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </>
  );
}
