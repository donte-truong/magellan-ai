"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowRight,
  Box,
  Check,
  ChevronDown,
  Globe2,
  Layers3,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { useWorkspace } from "@/lib/store";
import { ErrorNotice, Spinner } from "./ui";

export function ProductForm() {
  const [product, setProduct] = useState("");
  const [company, setCompany] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<{ input: string; key: string } | null>(null);
  const lock = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!product.trim() || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    const input = JSON.stringify([product.trim(), company.trim()]);
    if (request.current?.input !== input) request.current = { input, key: crypto.randomUUID() };
    controller.current = new AbortController();
    const generation = useWorkspace.getState().generation;
    try {
      const run = await api.decompose(
        product.trim(),
        company,
        request.current!.key,
        controller.current.signal,
      );
      if (!controller.current.signal.aborted && useWorkspace.getState().generation === generation)
        useWorkspace.getState().begin(run);
    } catch (error) {
      if (!controller.current.signal.aborted) setError(errorMessage(error));
    } finally {
      setBusy(false);
      lock.current = false;
    }
  }

  return (
    <div className="start-view">
      <div className="hero-heading">
        <div className="eyebrow">
          <span className="status-dot" /> PRODUCT INTELLIGENCE, FROM THE SOURCE
        </div>
        <h1>
          See what goes into
          <br />
          <span>what comes next.</span>
        </h1>
        <p>
          Start with a product. Uncover its components.
          <br className="desktop-break" /> Follow the connections back to the evidence.
        </p>
      </div>
      <div className="start-grid">
        <section className="product-card" aria-labelledby="form-title">
          <div className="section-kicker">
            <span className="square-icon">
              <Search size={19} />
            </span>
            <span>START AN EXPLORATION</span>
          </div>
          <h2 id="form-title">What are you curious about?</h2>
          <p className="muted">A specific product makes a good starting point.</p>
          <form onSubmit={submit}>
            <label htmlFor="product">
              Product name <span className="required-dot">*</span>
            </label>
            <div className="input-with-icon">
              <Box size={19} />
              <input
                id="product"
                ref={inputRef}
                placeholder="e.g. Raspberry Pi 5"
                value={product}
                onChange={(event) => setProduct(event.target.value)}
                maxLength={200}
                required
                disabled={busy}
                autoComplete="off"
              />
            </div>
            <details className="company-details">
              <summary>
                Add a company <span>Optional</span>
                <ChevronDown size={14} />
              </summary>
              <label htmlFor="company" className="sr-only">
                Company name
              </label>
              <input
                id="company"
                placeholder="e.g. Raspberry Pi"
                value={company}
                onChange={(event) => setCompany(event.target.value)}
                maxLength={200}
                disabled={busy}
              />
            </details>
            <button
              className="button button-primary submit-button"
              disabled={busy || !product.trim()}
              type="submit"
            >
              {busy ? (
                <Spinner label="Starting exploration" />
              ) : (
                <>
                  <span>Deconstruct product</span>
                  <ArrowRight size={18} />
                </>
              )}
            </button>
            {error && <ErrorNotice message={error} />}
          </form>
          <div className="sample-row">
            <span>Try an example</span>
            <button
              disabled={busy}
              onClick={() => {
                setProduct("Raspberry Pi 5");
                setCompany("");
                setError(null);
                inputRef.current?.focus();
              }}
            >
              Raspberry Pi 5 <ArrowUpSmall />
            </button>
          </div>
          <div className="form-footer">
            <ShieldCheck size={15} />
            <span>Public sources. Traceable claims. Visible uncertainty.</span>
          </div>
        </section>
        <NetworkPreview />
      </div>
      <div className="value-row">
        <div>
          <span className="value-icon">
            <Layers3 size={20} />
          </span>
          <section>
            <h3>Break it down</h3>
            <p>From finished product to the parts inside.</p>
          </section>
        </div>
        <div>
          <span className="value-icon">
            <Globe2 size={20} />
          </span>
          <section>
            <h3>Connect the dots</h3>
            <p>Explore how the supply network fits together.</p>
          </section>
        </div>
        <div>
          <span className="value-icon">
            <ShieldCheck size={20} />
          </span>
          <section>
            <h3>Check the evidence</h3>
            <p>Every relationship has a source to inspect.</p>
          </section>
        </div>
      </div>
    </div>
  );
}

function ArrowUpSmall() {
  return <ArrowRight size={13} className="sample-arrow" />;
}

function NetworkPreview() {
  return (
    <section
      className="network-preview"
      aria-label="Illustration of product, component, and material connections"
    >
      <div className="preview-top">
        <span>
          <span className="status-dot" /> A CLEARER PICTURE
        </span>
        <span className="preview-pill">From product to provenance</span>
      </div>
      <div className="preview-graph" aria-hidden="true">
        <svg className="preview-lines" viewBox="0 0 520 280" preserveAspectRatio="none">
          <path d="M130 142 C220 142 190 55 282 55 M130 142 C220 142 190 142 282 142 M130 142 C220 142 190 229 282 229 M360 55 C415 55 390 96 455 96 M360 142 C415 142 390 96 455 96 M360 229 C415 229 390 191 455 191" />
          <path className="line-highlight" d="M130 142 C220 142 190 142 282 142" />
        </svg>
        <div className="preview-node preview-root">
          <Box size={24} />
          <span>Your product</span>
          <small>THE STARTING POINT</small>
        </div>
        <div className="preview-node preview-component preview-one">
          <span className="mini-node-dot" />
          Component
          <span className="node-check">
            <Check size={11} />
          </span>
        </div>
        <div className="preview-node preview-component preview-two">
          <span className="mini-node-dot" />
          Component
          <span className="node-check">
            <Check size={11} />
          </span>
        </div>
        <div className="preview-node preview-component preview-three">
          <span className="mini-node-dot" />
          Component
          <span className="node-check">
            <Check size={11} />
          </span>
        </div>
        <div className="preview-material material-one">
          <span />
          <small>Material</small>
        </div>
        <div className="preview-material material-two">
          <span />
          <small>Material</small>
        </div>
        <div className="preview-evidence">
          <ShieldCheck size={13} />
          <span>Evidence at every connection</span>
        </div>
      </div>
      <div className="preview-bottom">
        <Sparkles size={16} />
        <p>
          Complex supply chains.
          <br />
          <strong>A little more clarity.</strong>
        </p>
        <span className="preview-caption">ILLUSTRATIVE NETWORK</span>
      </div>
    </section>
  );
}
