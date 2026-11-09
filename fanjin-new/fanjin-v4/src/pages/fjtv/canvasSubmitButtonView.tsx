import { ArrowUp,LoaderCircle } from "lucide-react";

export interface CanvasSubmitButtonViewDependencies {
  submitButtonIsPending: (key: string) => any;
  runWithSubmitButtonPending: (key: string, action: () => Promise<void> | void) => Promise<any>;
}

export function createCanvasSubmitButtonView({
  submitButtonIsPending,
  runWithSubmitButtonPending,
}: CanvasSubmitButtonViewDependencies) {
function renderCompactSubmitButton(
    key: string,
    action: () => Promise<void> | void,
    className = "flex h-10 w-10 items-center justify-center rounded-[12px] bg-white text-[#1a1b1d] disabled:cursor-wait disabled:opacity-80",
    iconClassName = "h-4.5 w-4.5",
    blocked = false,
  ) {
    const pending = submitButtonIsPending(key);
    return (
      <button
        type="button"
        className={className}
        disabled={pending || blocked}
        onClick={(event) => {
          event.stopPropagation();
          void runWithSubmitButtonPending(key, action);
        }}
      >
        {pending ? <LoaderCircle className={`${iconClassName} animate-spin`} /> : <ArrowUp className={iconClassName} />}
      </button>
    );
  }
  return { renderCompactSubmitButton };
}
