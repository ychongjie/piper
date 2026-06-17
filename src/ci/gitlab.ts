// 只读 GitLab 访问(经已认证的 glab)。通用:项目路径作参数,不绑死任何项目。
// 不触发、不重试、不改任何东西。
import { sh } from "../sh.ts";

export interface Pipeline {
  id: number;
  status: string;
  source: string;
  ref: string;
  created_at: string;
}

export interface Job {
  id: number;
  status: string;
  stage: string;
  name: string;
}

export interface GitlabReader {
  scheduledPipelines(n?: number): Promise<Pipeline[]>;
  pipelineJobs(pipelineId: number): Promise<Job[]>;
  jobTrace(jobId: number): Promise<string>;
}

/** 绑定到某个 GitLab 项目(如 "patronus/safeline-3")的只读访问器。 */
export function gitlabReader(projectPath: string): GitlabReader {
  const proj = encodeURIComponent(projectPath); // patronus/safeline-3 → patronus%2Fsafeline-3

  async function json<T = any>(path: string): Promise<T> {
    const r = await sh(`glab api "projects/${proj}${path}"`, { timeoutMs: 60_000 });
    if (!r.ok) throw new Error(`glab api ${path} 失败:${r.output.slice(0, 200)}`);
    return JSON.parse(r.stdout) as T;
  }

  return {
    scheduledPipelines: (n = 5) => json<Pipeline[]>(`/pipelines?source=schedule&per_page=${n}`),
    pipelineJobs: (id) => json<Job[]>(`/pipelines/${id}/jobs?per_page=100`),
    jobTrace: async (jobId) => {
      const r = await sh(`glab api "projects/${proj}/jobs/${jobId}/trace"`, { timeoutMs: 60_000 });
      if (!r.ok) throw new Error(`拉 job ${jobId} trace 失败:${r.output.slice(0, 200)}`);
      return r.stdout.replace(/\r/g, "");
    },
  };
}
