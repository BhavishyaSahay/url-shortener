// Shows an ApiError: its message, plus one line per invalid field for a 400.
export default function ErrorMessage({ error }) {
  if (!error) return null;
  return (
    <div className="error" role="alert">
      {error.message}
      {error.details?.length > 0 && (
        <ul>
          {error.details.map((d) => (
            <li key={d.field}>
              {d.field}: {d.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
