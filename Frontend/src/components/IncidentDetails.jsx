// Lets staff and admins record a fix or explain why a report was closed.
export function ResolutionNotes({ incident, onChange, onSave }) {
  return (
    <div className="resolution-notes">
      <label>
        Resolution / closure notes
        <textarea
          rows="2"
          value={incident.resolution_notes || ''}
          onChange={event => onChange(event.target.value)}
          placeholder="Describe the fix, or explain why this report was closed as invalid or duplicate."
        />
      </label>
      <button className="outline-button" onClick={() => onSave(incident)}>
        Save resolution notes
      </button>
    </div>
  )
}
