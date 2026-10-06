import { DashboardOverviewView } from './view';

// Auth-gated (DashboardShell renders pages only once the user is known): nothing to prerender here.
export const instant = false;

export default function Page() {
  return <DashboardOverviewView />;
}
