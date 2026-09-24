'use client';
import { Button, Dialog } from '@castlane/ui';

/**
 * Shown on 412 VERSION_CONFLICT: the user's own input stays in the form; they can reload the
 * latest version (discarding theirs) or keep editing and re-apply after reviewing.
 */
export const ConflictDialog = ({
  open,
  onOpenChange,
  onReload,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onReload: () => void;
}) => (
  <Dialog
    open={open}
    onOpenChange={onOpenChange}
    size="small"
    title="This record changed while you were editing it."
    description="Compare changes before saving. Your input is still in the form."
    footer={
      <>
        <Button onClick={() => onOpenChange(false)}>Keep Editing</Button>
        <Button variant="primary" onClick={onReload}>
          Reload Latest Version
        </Button>
      </>
    }
  >
    <p className="text-[14px] text-fg-2">
      Reloading shows the latest saved values and discards your unsaved changes. To keep your changes, copy them, reload, and apply them again —
      financial, approval and status changes are never merged automatically.
    </p>
  </Dialog>
);
