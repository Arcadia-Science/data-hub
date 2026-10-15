// The bulk bar drops out of view when a selection clears, so a screen reader
// would hear nothing. This hidden status region says what happened.
export function SelectionNotice({ message }: { message: string }) {
  return (
    <span aria-live="polite" className="sr-only" role="status">
      {message}
    </span>
  );
}
