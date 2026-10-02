import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api.js';
import ErrorMessage from '../components/ErrorMessage.jsx';

// One form for both pages; `mode` is 'login' or 'register'.
export default function AuthForm({ mode, onSuccess }) {
  const isLogin = mode === 'login';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault(); // stop the browser's own form submit (a full page reload)
    setError(null);
    setSubmitting(true);
    try {
      const { user } = isLogin ? await api.login(email, password) : await api.register(email, password);
      onSuccess(user); // App stores the user, and the routes then show the dashboard
    } catch (err) {
      setError(err);
      setSubmitting(false);
    }
  }

  return (
    <form className="card narrow" onSubmit={handleSubmit}>
      <h1>{isLogin ? 'Log in' : 'Create an account'}</h1>

      <label>
        Email
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
      </label>
      <label>
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={isLogin ? undefined : 8}
          autoComplete={isLogin ? 'current-password' : 'new-password'}
        />
        {!isLogin && <small className="muted">At least 8 characters</small>}
      </label>

      <ErrorMessage error={error} />
      <button type="submit" disabled={submitting}>
        {submitting ? 'Please wait…' : isLogin ? 'Log in' : 'Sign up'}
      </button>

      <p className="muted">
        {isLogin ? (
          <>
            No account? <Link to="/register">Sign up</Link>
          </>
        ) : (
          <>
            Already have an account? <Link to="/login">Log in</Link>
          </>
        )}
      </p>
    </form>
  );
}
