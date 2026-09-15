import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TaskCoordination } from "./ProjectCoordination";
const mock = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../api", () => ({ request: mock.request }));
afterEach(cleanup);
for (const state of ["running", "queued"]) {
  it("shows approval waiting only for its running assignment: " + state, async () => {
    mock.request.mockResolvedValue({
      config: { projectIdentity: {}, generalManager: { name: "general" }, businessManagers: [{ id: "business", name: "business" }] },
      assignments: [{ id: "assignment", taskIds: ["task"], managerId: "business", state, message: "assignment message" }],
      runtime: { business: { state: "waiting_user", message: "Approval required" } },
    });
    render(<TaskCoordination projectId="project" taskId="task" onOpenThread={() => {}} />);
    if (state === "running") {
      expect(await screen.findByText("Approval required")).toBeTruthy();
      expect(document.querySelector(".coordination-state")?.className).toContain("is-waiting_user");
      expect(screen.queryByText("assignment message")).toBeNull();
    } else {
      expect(await screen.findByText("assignment message")).toBeTruthy();
      expect(document.querySelector(".coordination-state")?.className).toContain("is-queued");
      expect(screen.queryByText("Approval required")).toBeNull();
    }
  });
}
