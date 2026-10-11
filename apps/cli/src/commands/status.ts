import { captureGitInfo } from "@uefn-devtools/core";
import { openEngine, print, type Command } from "../shared.ts";

export const status: Command = {
  name: "status",
  usage: "status",
  summary: "Project, adapter, session and git summary",
  async run(values) {
    const engine = await openEngine(values);
    const [project, git] = await Promise.all([engine.project(), captureGitInfo(engine.root)]);
    const data = {
      project: project.name,
      root: project.root,
      config: engine.loaded.file ?? null,
      adapter: engine.adapter.name,
      verseFiles: project.verseFiles.length,
      testFiles: project.testFiles.length,
      git: git ?? null,
    };
    print(values, data, () => {
      console.log(`Project   ${data.project}`);
      console.log(`Root      ${data.root}`);
      console.log(`Config    ${data.config ?? "(defaults, run 'uefn init')"}`);
      console.log(`Adapter   ${data.adapter}`);
      console.log(`Verse     ${data.verseFiles} file(s)`);
      console.log(`Tests     ${data.testFiles} file(s)`);
      if (git) console.log(`Git       ${git.branch ?? "(detached)"} ${git.commit ?? ""}${git.dirty ? " (dirty)" : ""}`);
    });
    return 0;
  },
};
