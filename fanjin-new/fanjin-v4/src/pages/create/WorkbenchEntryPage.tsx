import { lazy, Suspense } from "react";
import { useAuthStore } from "../../stores/authStore";
import { RouteGuard } from "../../routes/RouteGuard";
import GuestWorkbench from "./GuestWorkbench";
const QuickCreateView = lazy(() => import("./QuickCreateView"));
export default function WorkbenchEntryPage() {
  const token = useAuthStore((state) => state.token);
  return token ? (
    <RouteGuard meta={{ requiresAuth: true }}>
      <Suspense fallback={<div role="status">正在打开工作台…</div>}>
        <QuickCreateView />
      </Suspense>
    </RouteGuard>
  ) : (
    <GuestWorkbench />
  );
}
