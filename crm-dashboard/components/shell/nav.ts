import {
  BarChart3,
  ListChecks,
  MessagesSquare,
  Workflow,
  CheckSquare,
  FileText,
  Inbox,
  KanbanSquare,
  LayoutDashboard,
  MapPin,
  Send,
  Settings,
  Smartphone,
  Users,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  badge?: 'inbox' | 'tasks' | 'chat';
  status?: 'whatsapp';
  keywords?: string;
  /** Only shown to people with this permission. */
  requires?: 'scrape';
}

export const NAV: Array<{ group: string | null; items: NavItem[] }> = [
  {
    group: null,
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, keywords: 'home overview' },
      { href: '/inbox', label: 'Inbox', icon: Inbox, badge: 'inbox', keywords: 'chats replies conversations messages' },
      { href: '/chat', label: 'Team chat', icon: MessagesSquare, badge: 'chat', keywords: 'channels dm direct messages team group' },
      { href: '/tasks', label: 'Tasks', icon: CheckSquare, badge: 'tasks', keywords: 'todo reminders follow up meetings calls' },
    ],
  },
  {
    group: 'Leads',
    items: [
      { href: '/leads', label: 'All leads', icon: Users, keywords: 'contacts businesses crm' },
      { href: '/pipeline', label: 'Pipeline', icon: KanbanSquare, keywords: 'kanban deals stages board' },
      { href: '/lists', label: 'Lead lists', icon: ListChecks, keywords: 'groups segments share duplicates merge' },
      { href: '/scraper', label: 'Lead finder', icon: MapPin, keywords: 'scraper google maps search find', requires: 'scrape' },
    ],
  },
  {
    group: 'Outreach',
    items: [
      { href: '/campaigns', label: 'Campaigns', icon: Send, keywords: 'broadcast bulk outreach sequences' },
      { href: '/templates', label: 'Templates', icon: FileText, keywords: 'messages snippets spintax' },
      { href: '/automations', label: 'Automations', icon: Workflow, keywords: 'rules auto reply workflow triggers' },
      { href: '/whatsapp', label: 'WhatsApp numbers', icon: Smartphone, status: 'whatsapp', keywords: 'connect qr scan accounts phone' },
    ],
  },
  {
    group: 'Insights',
    items: [{ href: '/reports', label: 'Reports', icon: BarChart3, keywords: 'analytics stats performance team members leaderboard' }],
  },
];

export const SETTINGS_ITEM: NavItem = { href: '/settings', label: 'Settings', icon: Settings, keywords: 'team members invite workspace profile' };

export const ALL_NAV_ITEMS = [...NAV.flatMap((g) => g.items), SETTINGS_ITEM];
