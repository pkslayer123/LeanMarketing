import { test as base, expect } from "@playwright/test";
import * as path from "path";

// Import general-purpose simulation and oracle from runtime
const { SimulationAdapter } = require("../../scripts/e2e/lib/simulation-adapter");
const { OracleClient } = require("../../scripts/e2e/lib/oracle-client");

interface PersonaConfig {
  id?: string;
  name?: string;
  role?: string;
  department?: string;
  departmentId?: string;
  organizationId?: string;
  focus?: string[];
  traits?: Record<string, number>;
}

interface PersonaSim {
  baseUrl: string;
  adapter: InstanceType<typeof SimulationAdapter>;
  oracle: InstanceType<typeof OracleClient>;
  loginAsDeveloper: () => Promise<void>;
  simulateAs: (persona: PersonaConfig) => Promise<void>;
  swapTo: (persona: PersonaConfig) => Promise<void>;
  stopSimulation: () => Promise<void>;
  oracleCheck: (checkType: string, pageContent?: string) => Promise<OracleVerdict>;
  reportFinding: (finding: Finding) => void;
  apiRequest: (method: string, url: string, body?: unknown) => Promise<ApiResult>;
  getFindings: () => Finding[];
}

interface OracleVerdict {
  passed: boolean;
  findings: Array<{ severity: string; description: string }>;
  summary: string;
  tokensUsed: number;
  skipped?: boolean;
}

interface Finding {
  severity: string;
  description: string;
  page?: string;
  element?: string;
}

interface ApiResult {
  status: number;
  data: unknown;
}

export const test = base.extend<{ sim: PersonaSim }>({
  sim: async ({ page }, use) => {
    const baseUrl = process.env.BASE_URL ?? "https://leanmarketing.vercel.app";

    // Create general-purpose adapter and oracle
    const adapter = new SimulationAdapter(page, {
      baseUrl,
      auth: "supabase",
    });
    const oracle = new OracleClient();

    let currentPersona: PersonaConfig | null = null;

    const sim: PersonaSim = {
      baseUrl,
      adapter,
      oracle,

      loginAsDeveloper: async () => {
        await adapter.loginAsDeveloper();
      },

      simulateAs: async (persona: PersonaConfig) => {
        currentPersona = persona;
        await adapter.simulateAs(persona);
      },

      swapTo: async (persona: PersonaConfig) => {
        currentPersona = persona;
        await adapter.swapTo(persona);
      },

      stopSimulation: async () => {
        currentPersona = null;
        await adapter.stopSimulation();
      },

      oracleCheck: async (checkType: string, pageContent?: string) => {
        if (!oracle.isAvailable()) {
          return { passed: true, findings: [], summary: "No oracle key", tokensUsed: 0, skipped: true };
        }
        const content = pageContent || await page.content();
        return oracle.check({
          checkType,
          pageContent: content,
          url: page.url(),
          persona: currentPersona,
        });
      },

      reportFinding: (finding: Finding) => {
        adapter.reportFinding(finding);
      },

      apiRequest: async (method: string, url: string, body?: unknown) => {
        return adapter.apiRequest(method, url, body);
      },

      getFindings: () => adapter.getFindings(),
    };

    await use(sim);
  },
});

export { expect };
export function hasOracleKey(): boolean { return Boolean(process.env.GEMINI_API_KEY); }
