import { useEffect, useRef } from 'preact/hooks';

// Sign out asks first. The form posts to the Server's sign-out seam (F-2),
// which ends both this browser's sign-in and its hosted account session and
// lands on the hosted signed-out page.
export function SignOutDialog({
  action,
  onCancel,
  onSubmit,
}: {
  action: string;
  onCancel: () => void;
  /** Called just before the form posts. */
  onSubmit: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      class="dialog"
      aria-labelledby="signout-title"
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      <h2 id="signout-title" class="dialog-title">
        Sign out of Harklight?
      </h2>
      <p class="dialog-text">You will stop getting messages in this browser. Your iPhone stays signed in.</p>
      <form method="post" action={action} onSubmit={onSubmit}>
        <input type="hidden" name="confirm" value="sign_out" />
        <button type="submit" class="btn btn--block">
          Sign out
        </button>
      </form>
      <button type="button" class="btn btn--bordered btn--block" onClick={onCancel}>
        Cancel
      </button>
    </dialog>
  );
}
