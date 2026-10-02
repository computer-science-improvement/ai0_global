// Typed Lucide wrapper so call sites use a stable name set and consistent
// default size/stroke. Add new glyphs to ICONS as needed.
import {
  LayoutDashboard, Zap, CalendarClock, Radio, BarChart3, Search, Network,
  Star, Bot, FileText, Plug, Settings, Plus, Pencil, Trash2, RefreshCw,
  Check, X, Play, Pause, Info, TriangleAlert, ChevronLeft, ChevronRight,
  ChevronUp, ChevronDown, Send, Camera, Music2, AtSign, ThumbsUp, Menu,
  ScrollText, Sparkles, Rocket, SkipForward, CalendarSync, Eye,
  MessageSquare, Square, ArrowUp, Globe, Wrench, Clock, Ban, Database, BookOpen, PanelLeft,
  Megaphone, Radar, Users, Workflow, Lock, LockOpen, Inbox, History, ImageOff, ArrowUpRight, Lightbulb,
  type LucideIcon,
} from 'lucide-react';

const ICONS = {
  overview: LayoutDashboard, strategies: Zap, calendar: CalendarClock,
  channels: Radio, analytics: BarChart3, discovery: Search, graph: Network,
  recommendations: Star, bots: Bot, telegraph: FileText, connections: Plug,
  settings: Settings, plus: Plus, pencil: Pencil, trash: Trash2,
  refresh: RefreshCw, check: Check, x: X, play: Play, pause: Pause,
  info: Info, warning: TriangleAlert, 'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight, 'chevron-up': ChevronUp,
  'chevron-down': ChevronDown, telegram: Send, instagram: Camera,
  tiktok: Music2, threads: AtSign, facebook: ThumbsUp, menu: Menu,
  logs: ScrollText, sparkles: Sparkles, rocket: Rocket, 'skip-forward': SkipForward,
  'calendar-sync': CalendarSync, eye: Eye,
  chat: MessageSquare, stop: Square, 'arrow-up': ArrowUp, globe: Globe, wrench: Wrench,
  clock: Clock, ban: Ban, database: Database, book: BookOpen, 'panel-left': PanelLeft,
  megaphone: Megaphone, radar: Radar, users: Users,
  agents: Workflow, lock: Lock, unlock: LockOpen, inbox: Inbox, history: History,
  'image-off': ImageOff, external: ArrowUpRight, hint: Lightbulb,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 16, className, strokeWidth = 1.75 }: {
  name: IconName; size?: number; className?: string; strokeWidth?: number;
}) {
  const Glyph = ICONS[name];
  return <Glyph size={size} className={className} strokeWidth={strokeWidth} />;
}
