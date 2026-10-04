import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runAgent, validateContactPage } from "../src/agent";
import { validateClaims } from "../src/tools";

describe("validateClaims", () => {
  const searchResults = new Set(["https://example.com/about"]);
  const validClaims = [
    { text: "Claim one", source_url: "https://example.com/about" },
    { text: "Claim two", source_url: "https://example.com/about" },
    { text: "Claim three", source_url: "https://example.com/about" },
  ];

  test("accepts exactly three claims sourced from search results", () => {
    expect(validateClaims(validClaims, searchResults)).toBeNull();
  });

  test("rejects a claim count other than three", () => {
    expect(validateClaims(validClaims.slice(0, 2), searchResults)).toBe("exactly three claims are required");
    expect(validateClaims([...validClaims, validClaims[0]], searchResults)).toBe("exactly three claims are required");
  });

  test("rejects a claim with empty or whitespace-only text", () => {
    for (const text of ["", " \t\n"]) {
      expect(validateClaims(validClaims.map((claim) => ({ ...claim, text })), searchResults))
        .toBe("each claim must have non-empty text");
    }
  });

  test("rejects a source URL that was not returned by search", () => {
    expect(validateClaims([
      ...validClaims.slice(0, 2),
      { text: "Claim three", source_url: "https://unrelated.example" },
    ], searchResults)).toContain("source_url must match a URL returned by web_search");
  });
});

describe("validateContactPage", () => {
  const searchResults = [{
    title: "Contact Example Corp",
    snippet: "Get in touch",
    url: "https://example.com/contact",
  }];

  test("keeps a contact page URL supported by search", () => {
    const response = "Public contact page: https://example.com/contact";
    expect(validateContactPage(response, searchResults)).toBe(response);
  });

  test("rejects unsupported contact URLs on the line after the contact label", () => {
    expect(validateContactPage("Public contact page:\nhttps://fake.example/contact", searchResults))
      .toBe("Public contact page: not found.");
  });

  test("rejects unsupported contact-page URL label variants", () => {
    for (const response of [
      "Public contact page URL: https://fake.example/contact",
      "Public contact-page URL: https://fake.example/contact",
      "Contact page: https://fake.example/contact",
      "Contact URL: https://fake.example/contact",
    ]) {
      expect(validateContactPage(response, searchResults)).toBe("Public contact page: not found.");
    }
  });

  test("replaces an unsupported contact URL with not found", () => {
    expect(validateContactPage("Public contact page: https://fake.example/contact", searchResults))
      .toBe("Public contact page: not found.");
  });

  test("preserves unrelated contact mentions and links", () => {
    const response = "Email draft: Contact our press team at press@example.com; source https://example.com/report";
    expect(validateContactPage(response, searchResults)).toBe(`${response}\nPublic contact page: not found.`);
  });

  test("does not accept a generic URL as a contact page", () => {
    expect(validateContactPage("For contact information see https://example.com/about", [{
      title: "Company overview",
      snippet: "About us",
      url: "https://example.com/about",
    }])).toBe("For contact information see https://example.com/about\nPublic contact page: not found.");
  });

  test("reports not found when no supported contact page is offered", () => {
    expect(validateContactPage("No contact details in the results.", []))
      .toBe("No contact details in the results.\nPublic contact page: not found.");
  });
});

describe("runAgent response limit", () => {
  const previousKey = process.env.OPENROUTER_API_KEY;
  const previousFetch = globalThis.fetch;
  let requestBody: { max_tokens?: number } | undefined;
  let mockResponse: Record<string, unknown>;

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "test-key";
    requestBody = undefined;
    mockResponse = {
      choices: [{
        message: { content: "Draft ends mid-sent", tool_calls: [] },
        finish_reason: "length",
      }],
    };
    const mockFetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, { preconnect: previousFetch.preconnect });
  });

  afterEach(() => {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  });

  test("reports a cut-off completion instead of returning incomplete text", async () => {
    await expect(runAgent(undefined, "pester Acme")).resolves.toBe(
      "The action kit exceeded the 4096-token response limit and was cut off. Please retry with a narrower request.",
    );
    expect(requestBody?.max_tokens).toBe(4096);
  });

  test("stops if a cut-off completion includes partial tool calls", async () => {
    mockResponse = {
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "partial",
            type: "function",
            function: { name: "unexpected_tool", arguments: "{}" },
          }],
        },
        finish_reason: "length",
      }],
    };

    await expect(runAgent(undefined, "pester Acme")).resolves.toBe(
      "The action kit exceeded the 4096-token response limit and was cut off. Please retry with a narrower request.",
    );
  });
});
