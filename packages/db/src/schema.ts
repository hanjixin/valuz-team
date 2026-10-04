/**
 * Database schema types. Hand-maintained alongside the migrations until the
 * schema settles; `kysely-codegen` can regenerate it from a live database.
 */
import type { ColumnType } from "kysely";

export interface AppMetaTable {
  key: string;
  value: ColumnType<unknown, string, string>;
  updated_at: ColumnType<Date, Date | undefined, Date | undefined>;
}

export interface Database {
  app_meta: AppMetaTable;
}
