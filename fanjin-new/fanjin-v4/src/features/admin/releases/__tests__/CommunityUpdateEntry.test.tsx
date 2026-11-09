// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const { apiGet, stepUp } = vi.hoisted(() => ({ apiGet:vi.fn(), stepUp:vi.fn() }));
vi.mock("../../../../api/http",async(importOriginal)=>({ ...await importOriginal<typeof import("../../../../api/http")>(), apiGet }));
vi.mock("../../../../api/stepUp",async(importOriginal)=>({ ...await importOriginal<typeof import("../../../../api/stepUp")>(), apiPostWithStepUp:stepUp }));
import Page from "../Page";
afterEach(()=>{cleanup();vi.clearAllMocks();});
it("managed installs show local updates without loading the company publisher", async()=>{
  apiGet.mockResolvedValue({managed:true});
  const view=render(<Page />);
  await waitFor(()=>expect(screen.getByRole("button",{name:"检查本机更新"})).toBeTruthy());
  expect(apiGet).toHaveBeenCalledWith("/admin/releases/community-update");
  expect(view.container.querySelector("iframe")).toBeNull();
});
