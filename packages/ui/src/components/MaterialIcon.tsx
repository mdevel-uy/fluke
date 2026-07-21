import type { HTMLAttributes } from 'react';
import {
  Archive,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Circle,
  CircleAlert,
  CircleDot,
  ClipboardList,
  Download,
  ExternalLink,
  FileDiff,
  GitBranch,
  GitMerge,
  Layers,
  LayoutGrid,
  Link,
  Loader2,
  Menu,
  MessageSquare,
  Monitor,
  MoreHorizontal,
  MoreVertical,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Settings,
  SquareKanban,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  UserPlus,
  Users,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../lib/cn';

/**
 * Compatibility shim: keeps the legacy Material Symbols `name` API but
 * renders lucide-react icons (the single icon set per design/UI-SPEC.md).
 * The Material Symbols icon font is no longer bundled.
 */
export interface MaterialIconProps extends HTMLAttributes<HTMLSpanElement> {
  name: string;
  /** Legacy prop, ignored — lucide has no fill axis; active state is color */
  fill?: 0 | 1;
  /** Legacy font weight; >=500 renders a heavier stroke */
  weight?: 100 | 200 | 300 | 400 | 500 | 600 | 700;
  /** Legacy optical size, ignored */
  opsz?: 20 | 24 | 40 | 48;
  size?: 'xs' | 'sm' | 'base' | 'lg' | 'xl';
}

const ICONS: Record<string, LucideIcon> = {
  add: Plus,
  archive: Archive,
  arrow_back: ArrowLeft,
  bolt: Zap,
  call_merge: GitMerge,
  chat: MessageSquare,
  check: Check,
  chevron_left: ChevronLeft,
  close: X,
  delete: Trash2,
  difference: FileDiff,
  download: Download,
  error: CircleAlert,
  expand_more: ChevronDown,
  fork_right: GitBranch,
  grid_view: LayoutGrid,
  group: Users,
  keyboard_arrow_down: ChevronDown,
  keyboard_arrow_up: ChevronUp,
  layers: Layers,
  link: Link,
  list_alt: ClipboardList,
  menu: Menu,
  menu_open: PanelLeftOpen,
  monitor: Monitor,
  more_horiz: MoreHorizontal,
  more_vert: MoreVertical,
  open_in_new: ExternalLink,
  person_add: UserPlus,
  progress_activity: Loader2,
  radio_button_checked: CircleDot,
  refresh: RefreshCw,
  settings: Settings,
  terminal: SquareTerminal,
  view_kanban: SquareKanban,
  warning: TriangleAlert,
};

const sizePx: Record<NonNullable<MaterialIconProps['size']>, number> = {
  xs: 14,
  sm: 16,
  base: 20,
  lg: 22,
  xl: 24,
};

export function MaterialIcon({
  name,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, unused-imports/no-unused-vars
  fill: _fill,
  weight = 400,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, unused-imports/no-unused-vars
  opsz: _opsz,
  size = 'base',
  className,
  style,
  ...props
}: MaterialIconProps) {
  const Icon = ICONS[name] ?? Circle;
  return (
    <span
      className={cn('inline-flex shrink-0 align-middle', className)}
      style={style}
      aria-hidden="true"
      {...props}
    >
      <Icon
        size={sizePx[size]}
        strokeWidth={weight >= 500 ? 2 : 1.75}
        aria-hidden="true"
      />
    </span>
  );
}
