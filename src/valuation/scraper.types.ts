export type SupportedCurrency = "EUR" | "USD" | "GBP";

export type ScraperSourceResult = {
  price: number;

  currency?: SupportedCurrency | null;

  source: string;
  confidence: number;

  matchedTitle?: string;
  matchedUrl?: string;

  query?: string;

  metadata?: Record<string, unknown>;
};

export type ScraperAttemptLog = {
  source: string;

  query?: string;

  status: "SUCCESS" | "NO_DATA" | "ERROR";

  matchedTitle?: string;
  matchedUrl?: string;

  matchedPrice?: number;

  currency?: SupportedCurrency | null;

  confidence?: number;

  errorMessage?: string;
};