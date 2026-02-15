/**
 * Website Analyzer — Fetches and extracts key information from a website.
 *
 * Used during market analysis to provide the LLM with actual website content
 * instead of letting it guess/hallucinate about the site.
 *
 * Extracts: page title, meta description, headings, navigation links,
 * service pages, city/area mentions, CTAs, social proof, contact info.
 */

interface WebsiteAnalysisResult {
  url: string;
  title: string;
  metaDescription: string;
  headings: string[];
  navigationLinks: { text: string; href: string }[];
  servicePages: string[];
  cityMentions: string[];
  socialProof: string[];
  contactInfo: string[];
  ctaButtons: string[];
  bodyTextSample: string;
  error?: string;
}

/**
 * Fetches a website and extracts key content for LLM analysis.
 * Timeout after 10 seconds. Returns a structured summary.
 */
export async function analyzeWebsite(inputUrl: string): Promise<WebsiteAnalysisResult> {
  // Normalize URL
  let url = inputUrl.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = `https://${url}`;
  }

  const result: WebsiteAnalysisResult = {
    url,
    title: '',
    metaDescription: '',
    headings: [],
    navigationLinks: [],
    servicePages: [],
    cityMentions: [],
    socialProof: [],
    contactInfo: [],
    ctaButtons: [],
    bodyTextSample: '',
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'PaintWiser-Bot/1.0 (Market Analysis)',
        'Accept': 'text/html',
      },
    });
    clearTimeout(timeout);

    if (!response.ok) {
      result.error = `HTTP ${response.status}`;
      return result;
    }

    const html = await response.text();

    // Extract title
    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
    result.title = titleMatch ? cleanText(titleMatch[1]) : '';

    // Extract meta description
    const metaMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*?)["']/i)
      || html.match(/<meta[^>]*content=["']([^"']*?)["'][^>]*name=["']description["']/i);
    result.metaDescription = metaMatch ? cleanText(metaMatch[1]) : '';

    // Extract headings (h1-h3)
    const headingRegex = /<h[1-3][^>]*>(.*?)<\/h[1-3]>/gi;
    let match;
    while ((match = headingRegex.exec(html)) !== null) {
      const text = cleanText(stripTags(match[1]));
      if (text && text.length > 2 && text.length < 200) {
        result.headings.push(text);
      }
    }
    result.headings = [...new Set(result.headings)].slice(0, 30);

    // Extract navigation/menu links
    const linkRegex = /<a[^>]*href=["']([^"'#]*?)["'][^>]*>(.*?)<\/a>/gi;
    const seenLinks = new Set<string>();
    while ((match = linkRegex.exec(html)) !== null) {
      const href = match[1].trim();
      const text = cleanText(stripTags(match[2]));
      if (text && text.length > 1 && text.length < 60 && href && !seenLinks.has(href)) {
        seenLinks.add(href);
        result.navigationLinks.push({ text, href });
      }
    }
    result.navigationLinks = result.navigationLinks.slice(0, 50);

    // Identify service pages (links containing "service" or service-related keywords)
    const serviceKeywords = ['service', 'painting', 'cabinet', 'exterior', 'interior', 'commercial', 'stain', 'color', 'residential'];
    result.servicePages = result.navigationLinks
      .filter(link =>
        serviceKeywords.some(kw =>
          link.href.toLowerCase().includes(kw) || link.text.toLowerCase().includes(kw)
        )
      )
      .map(link => `${link.text} (${link.href})`)
      .slice(0, 15);

    // Extract CTA buttons / links
    const ctaRegex = /<(?:a|button)[^>]*(?:class=["'][^"']*(?:cta|btn|button|book|quote|estimate|call)[^"']*["'|>])[^>]*>(.*?)<\/(?:a|button)>/gi;
    while ((match = ctaRegex.exec(html)) !== null) {
      const text = cleanText(stripTags(match[1]));
      if (text && text.length > 2 && text.length < 60) {
        result.ctaButtons.push(text);
      }
    }
    // Also look for common CTA text patterns
    const ctaTextRegex = /<(?:a|button)[^>]*>(.*?(?:free (?:quote|estimate)|book (?:online|now)|call (?:now|us|today)|get (?:started|a quote|your|pricing)|schedule|contact us).*?)<\/(?:a|button)>/gi;
    while ((match = ctaTextRegex.exec(html)) !== null) {
      const text = cleanText(stripTags(match[1]));
      if (text && text.length > 2 && text.length < 80) {
        result.ctaButtons.push(text);
      }
    }
    result.ctaButtons = [...new Set(result.ctaButtons)].slice(0, 10);

    // Extract phone numbers
    const phoneRegex = /(?:tel:)?((?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4})/g;
    const phones = new Set<string>();
    while ((match = phoneRegex.exec(html)) !== null) {
      const phone = match[1].trim();
      if (phone.replace(/\D/g, '').length >= 10) {
        phones.add(phone);
      }
    }
    result.contactInfo = [...phones].slice(0, 5);

    // Extract email addresses
    const emailRegex = /[\w.+-]+@[\w-]+\.[\w.]+/g;
    while ((match = emailRegex.exec(html)) !== null) {
      result.contactInfo.push(match[0]);
    }
    result.contactInfo = [...new Set(result.contactInfo)].slice(0, 8);

    // Extract social proof indicators
    const socialProofPatterns = [
      /(\d+[\+]?\s*(?:years?|yrs?)(?:\s+(?:of\s+)?experience)?)/gi,
      /(\d+[\+]?\s*(?:happy\s+)?(?:customers?|clients?|homeowners?))/gi,
      /(\d+\.?\d*\s*(?:star|★|⭐)?\s*(?:rating|rated|reviews?|on google))/gi,
      /(satisfaction\s*guaranteed)/gi,
      /(licensed\s*(?:&|and)?\s*insured)/gi,
      /(CSLB[^<]{0,40})/gi,
      /(BBB\s*[A+]+\s*rated)/gi,
    ];
    for (const pattern of socialProofPatterns) {
      while ((match = pattern.exec(html)) !== null) {
        const text = cleanText(stripTags(match[1]));
        if (text) result.socialProof.push(text);
      }
    }
    result.socialProof = [...new Set(result.socialProof)].slice(0, 15);

    // Extract body text sample (strip all tags, get first ~1500 chars)
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    if (bodyMatch) {
      const bodyText = stripTags(bodyMatch[1])
        .replace(/\s+/g, ' ')
        .trim();
      result.bodyTextSample = bodyText.slice(0, 1500);
    }

  } catch (err) {
    if (err instanceof Error) {
      result.error = err.name === 'AbortError' ? 'Timeout (10s)' : err.message;
    } else {
      result.error = 'Unknown error fetching website';
    }
  }

  return result;
}

/**
 * Formats the website analysis result into a concise text block for the LLM prompt.
 */
export function formatWebsiteForPrompt(analysis: WebsiteAnalysisResult): string {
  if (analysis.error) {
    return `Website: ${analysis.url}\nError fetching: ${analysis.error}\nNote: Could not analyze the website. Provide general recommendations.`;
  }

  const sections: string[] = [];

  sections.push(`Website: ${analysis.url}`);
  if (analysis.title) sections.push(`Page Title: ${analysis.title}`);
  if (analysis.metaDescription) sections.push(`Meta Description: ${analysis.metaDescription}`);

  if (analysis.servicePages.length > 0) {
    sections.push(`\nService Pages Found (${analysis.servicePages.length}):`);
    for (const page of analysis.servicePages) {
      sections.push(`  - ${page}`);
    }
  } else {
    sections.push('\nService Pages: NONE FOUND');
  }

  if (analysis.headings.length > 0) {
    sections.push(`\nPage Headings:`);
    for (const h of analysis.headings.slice(0, 15)) {
      sections.push(`  - ${h}`);
    }
  }

  if (analysis.ctaButtons.length > 0) {
    sections.push(`\nCTAs/Buttons: ${analysis.ctaButtons.join(', ')}`);
  } else {
    sections.push('\nCTAs/Buttons: NONE FOUND');
  }

  if (analysis.socialProof.length > 0) {
    sections.push(`\nSocial Proof/Trust Signals: ${analysis.socialProof.join(', ')}`);
  } else {
    sections.push('\nSocial Proof: NONE FOUND on homepage');
  }

  if (analysis.contactInfo.length > 0) {
    sections.push(`\nContact Info: ${analysis.contactInfo.join(', ')}`);
  }

  // Check for city/location pages
  const cityLinks = analysis.navigationLinks.filter(l =>
    l.href.toLowerCase().includes('area') ||
    l.href.toLowerCase().includes('city') ||
    l.href.toLowerCase().includes('location') ||
    l.href.toLowerCase().includes('service-area')
  );
  if (cityLinks.length > 0) {
    sections.push(`\nCity/Area Pages: ${cityLinks.map(l => `${l.text} (${l.href})`).join(', ')}`);
  }

  if (analysis.bodyTextSample) {
    sections.push(`\nPage Content Sample:\n${analysis.bodyTextSample.slice(0, 800)}`);
  }

  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripTags(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
