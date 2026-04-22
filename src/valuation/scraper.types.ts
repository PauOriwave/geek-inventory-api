export type ScraperSourceResult = {
  price: number;
  source: string;
  confidence: number;
  matchedTitle?: string;
  matchedUrl?: string;
  query?: string;
};

export type ScraperAttemptLog = {
  source: string;
  query?: string;
  status: "SUCCESS" | "NO_DATA" | "ERROR";
  matchedTitle?: string;
  matchedUrl?: string;
  matchedPrice?: number;
  confidence?: number;
  errorMessage?: string;
};