/**
 * Shared table layout constants.
 *
 * These are read by both the markdown→storage pipeline (when emitting a
 * `<table data-table-width="...">`) and the storage→markdown pipeline (when
 * mapping a pixel width back to a named layout comment).
 */

export const TABLE_WIDTH_PX: Record<string, number> = {
  content: 760,
  wider: 960,
  full: 1800,
};

export function tableWidthToLayoutName(px: number): string {
  if (px > 1100) {
    return "full";
  }
  if (px > 800) {
    return "wider";
  }
  return "content";
}
