import _ from "lodash";
import { readFileSync as rf } from "node:fs";
import { level } from "./util";

export type MemberKind = "field" | "property" | "method";

export const MAX_DEPTH: number = 8;

export const RULES: readonly string[] = [
  "E1001",
  "E1002",
];

export function loadText(path: string, encoding?: string): string {
  return rf(path, encoding ?? "utf8");
}

export function pickFirst<T>(items: T[]): T {
  return items[0]!;
}

export enum color {
  red,
  green = 2,
  blue
}

export interface printable {
  readonly kind: "printable";
  readonly id: string;
  note?: string;
  print(): string;
}

export interface named extends printable {
  tag: string;
  describe(): string;
}

export class point {
  public x: number = 0;
  public y: number = 0;

  public move(dx: number, dy: number): void {
    this.x = this.x + dx;
    this.y = this.y + dy;
  }

  constructor(x?: number, y?: number) {
    this.x = x ?? 0;
    this.y = y ?? 0;
  }
}

export class box<T extends object> extends point implements printable {
  public readonly kind: "printable" = "printable";
  public id: string = "box";
  public tags: string[] = [];
  public logLevel: level = level.info;
  public static readonly ORIGIN: string = "0,0";
  private raw: number = 0;
  public static count: number = 0;
  #label: string = "unnamed";

  public get label(): string { return this.#label; }
  private set label(value: string) { this.#label = value; }

  public get score(): number { return this.raw; }
  public set score(value: number) {
    if (value < 0) throw new Error("score must be >= 0");
    this.raw = value;
  }

  public print(): string {
    return this.id;
  }

  public chunk2(list: number[]): number[][] {
    return _.chunk(list, 2);
  }

  public async load(url: string): Promise<string> {
    const r = await fetch(url);
    return r.text();
  }

  public *tick(): Generator<number> {
    yield 1;
    yield 2;
  }

  private clamp(v: number): number {
    return v < 0 ? 0 : v;
  }
}

export class cache<K extends string, V = any> {
  public hits: number = 0;
  public data: Map<K, V> = new Map();
}
