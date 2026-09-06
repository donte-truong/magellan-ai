"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  ChevronDown,
  Search,
  ShieldCheck,
  Smartphone,
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
    <section className="studio-start" aria-labelledby="start-title">
      <div className="studio-constellation" aria-hidden="true">
        <svg viewBox="0 0 1000 640" fill="none">
          <defs>
            <radialGradient id="start-glow">
              <stop stopColor="#82bffc" stopOpacity=".13" />
              <stop offset="1" stopColor="#82bffc" stopOpacity="0" />
            </radialGradient>
          </defs>
          <ellipse cx="500" cy="300" rx="450" ry="290" fill="url(#start-glow)" />
          <g className="constellation-lines">
            <path d="M65 155 210 90 320 180 200 305 70 430 235 535 370 480M65 155 200 305 40 295M320 180 370 480M210 90 465 45 660 100 785 65 930 210 800 315 940 470 755 550 650 460M660 100 800 315 650 460M785 65 800 315M755 550 505 595 370 480M930 210 975 355 940 470" />
          </g>
          {[
            [65, 155],
            [210, 90],
            [320, 180],
            [200, 305],
            [70, 430],
            [235, 535],
            [370, 480],
            [40, 295],
            [465, 45],
            [660, 100],
            [785, 65],
            [930, 210],
            [800, 315],
            [940, 470],
            [755, 550],
            [650, 460],
            [505, 595],
            [975, 355],
          ].map(([cx, cy], i) => (
            <circle
              key={i}
              cx={cx}
              cy={cy}
              r={i % 3 === 0 ? 4 : 2.5}
              className="constellation-point"
              style={{ animationDelay: `${i * 0.31}s` }}
            />
          ))}
        </svg>
      </div>
      <div className="studio-start-content">
        <span className="studio-eyebrow">
          <span className="studio-status-dot" /> YOUR NEXT DISCOVERY STARTS HERE
        </span>
        <h1 id="start-title">
          Every product has
          <br />
          <span>a story beneath it.</span>
        </h1>
        <p>Trace its parts. Meet its makers. Follow the evidence.</p>
        <form className="studio-product-form" onSubmit={submit}>
          <div className="studio-product-input">
            <Search size={21} />
            <label htmlFor="product" className="sr-only">
              Product name
            </label>
            <input
              id="product"
              ref={inputRef}
              placeholder="Which product will you explore?"
              value={product}
              onChange={(event) => setProduct(event.target.value)}
              maxLength={200}
              required
              disabled={busy}
              autoComplete="off"
            />
            <button className="studio-primary" disabled={busy || !product.trim()} type="submit">
              {busy ? (
                <Spinner label="Starting exploration" />
              ) : (
                <>
                  <span>Explore</span>
                  <ArrowRight size={17} />
                </>
              )}
            </button>
          </div>
          <details className="studio-company">
            <summary>
              Add a company <span>Optional</span>
              <ChevronDown size={13} />
            </summary>
            <label htmlFor="company" className="sr-only">
              Company name
            </label>
            <input
              id="company"
              placeholder="Company or manufacturer"
              value={company}
              onChange={(event) => setCompany(event.target.value)}
              maxLength={200}
              disabled={busy}
            />
          </details>
          {error && <ErrorNotice message={error} />}
        </form>
        <div className="studio-examples">
          <span>Start with</span>
          {["Raspberry Pi 5", "Framework Laptop 13"].map((name) => (
            <button
              key={name}
              disabled={busy}
              onClick={() => {
                setProduct(name);
                setCompany("");
                setError(null);
                inputRef.current?.focus();
              }}
            >
              {name}
              <ArrowUpRight size={12} />
            </button>
          ))}
        </div>
        <a className="studio-demo-link" href="/demo">
          <span className="studio-demo-icon">
            <Smartphone size={18} />
          </span>
          <span>
            Just looking around?
            <strong>
              Explore the iPhone demo <ArrowRight size={14} />
            </strong>
          </span>
        </a>
      </div>
      <div className="studio-start-caption">
        <ShieldCheck size={14} /> Public sources. Connections you can inspect.
      </div>
    </section>
  );
}
