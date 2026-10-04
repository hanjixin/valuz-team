/** The bundled team templates, carried over from valuz-agent (see UPSTREAM.md). Generated list — one import per pack. */
import academicResearch from "./academic-research.json" with { type: "json" };
import campaignEvent from "./campaign-event.json" with { type: "json" };
import chineseMetaphysics from "./chinese-metaphysics.json" with { type: "json" };
import competitiveIntelligence from "./competitive-intelligence.json" with { type: "json" };
import complianceReview from "./compliance-review.json" with { type: "json" };
import contentGrowth from "./content-growth.json" with { type: "json" };
import content from "./content.json" with { type: "json" };
import contractReview from "./contract-review.json" with { type: "json" };
import designPrototype from "./design-prototype.json" with { type: "json" };
import developmentEngineering from "./development-engineering.json" with { type: "json" };
import healthReport from "./health-report.json" with { type: "json" };
import investment from "./investment.json" with { type: "json" };
import productStrategy from "./product-strategy.json" with { type: "json" };
import product from "./product.json" with { type: "json" };
import qaTesting from "./qa-testing.json" with { type: "json" };
import recruitingEvaluation from "./recruiting-evaluation.json" with { type: "json" };
import riskControl from "./risk-control.json" with { type: "json" };
import shortVideoGrowth from "./short-video-growth.json" with { type: "json" };
import statisticalAnalysis from "./statistical-analysis.json" with { type: "json" };
import supplyChainTracking from "./supply-chain-tracking.json" with { type: "json" };
import tarotAstrology from "./tarot-astrology.json" with { type: "json" };
import teachingMaterial from "./teaching-material.json" with { type: "json" };
import trainingProgram from "./training-program.json" with { type: "json" };
import videoProduction from "./video-production.json" with { type: "json" };

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface Localized {
  "zh-CN": string;
  "en-US": string;
}

export interface Pack {
  id: string;
  name: Localized;
  description: Localized;
  scenario: Localized;
  icon: string;
  roles: {
    slug: string;
    name: Localized;
    description: Localized;
    instructions: Localized;
    avatar: string;
    effort: Effort | null;
  }[];
}

// JSON is typed loosely (an effort is "a string"); the packs are checked to hold the real values.
export const PACKS = [
  academicResearch,
  campaignEvent,
  chineseMetaphysics,
  competitiveIntelligence,
  complianceReview,
  contentGrowth,
  content,
  contractReview,
  designPrototype,
  developmentEngineering,
  healthReport,
  investment,
  productStrategy,
  product,
  qaTesting,
  recruitingEvaluation,
  riskControl,
  shortVideoGrowth,
  statisticalAnalysis,
  supplyChainTracking,
  tarotAstrology,
  teachingMaterial,
  trainingProgram,
  videoProduction,
] as Pack[];
