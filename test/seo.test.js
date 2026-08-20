import assert from 'node:assert/strict';
import test from 'node:test';
import { ISSUE_PAGES, PLANS, SEO_PATHS, renderActionPage, renderDistrict, renderIssue, renderLisa, renderPlan, renderPlansIndex, renderIssuesIndex } from '../seo-pages.js';

const forbidden = /troy\s+carter/i;
const canonical = (html) => html.match(/<link rel="canonical" href="([^"]+)">/)?.[1];
const title = (html) => html.match(/<title>([^<]+)<\/title>/)?.[1];

test('publishes all 32 Freedom Plans at unique crawlable URLs', () => {
  assert.equal(PLANS.length, 32);
  assert.equal(new Set(PLANS.map((plan) => plan.slug)).size, 32);
  for (const plan of PLANS) {
    const html = renderPlan(plan);
    assert.equal(canonical(html), `https://ballayforcongress.com/freedom-plans/${plan.slug}`);
    assert.match(html, /application\/ld\+json/);
    assert.doesNotMatch(html, forbidden);
  }
});

test('renders unique issue pages with FAQs and related plans', () => {
  assert.equal(new Set(ISSUE_PAGES.map((issue) => issue.slug)).size, ISSUE_PAGES.length);
  for (const issue of ISSUE_PAGES) {
    const html = renderIssue(issue);
    assert.equal(canonical(html), `https://ballayforcongress.com/issues/${issue.slug}`);
    assert.match(html, /FAQPage/);
    assert.doesNotMatch(html, forbidden);
  }
});

test('every SEO landing page has a unique title and canonical', () => {
  const pages = [renderLisa(), renderDistrict(), renderIssuesIndex(), renderPlansIndex(), renderActionPage('volunteer'), renderActionPage('yard-signs'), renderActionPage('friends-of-lisa'), ...ISSUE_PAGES.map(renderIssue), ...PLANS.map(renderPlan)];
  assert.equal(new Set(pages.map(title)).size, pages.length);
  assert.equal(new Set(pages.map(canonical)).size, pages.length);
  assert.equal(SEO_PATHS.length, pages.length + 1); // includes the existing get-involved page
  for (const html of pages) {
    assert.match(html, /<meta name="description"/);
    assert.match(html, /<meta name="robots" content="index,follow/);
    assert.doesNotMatch(html, forbidden);
  }
});
