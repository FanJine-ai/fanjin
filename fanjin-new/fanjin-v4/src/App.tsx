import { Suspense } from "react";
import { RouterProvider } from "react-router-dom";
import { router } from "./routes";
import { useV4Theme } from "./ui/useV4Theme";
import { StepUpProvider } from "./components/StepUpProvider";
import { ToastProvider } from "./ui/console/feedback";
import FeedbackWidget from "./features/feedback/FeedbackWidget";

export default function App() {
  const theme = useV4Theme();

  return (
    <Suspense
      fallback={
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: "100vh",
            background: theme.bg,
            color: theme.textSecondary,
            fontSize: 15,
          }}
        >
          加载中…
        </div>
      }
    >
      <ToastProvider>
        <StepUpProvider>
          <RouterProvider router={router} />
          <FeedbackWidget />
        </StepUpProvider>
      </ToastProvider>
    </Suspense>
  );
}
