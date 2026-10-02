/** SQL migration files are bundled as text by Vite and the Worker test runtime. */
declare module '*.sql' {
  /** The SQL source of a generated Drizzle migration. */
  const sql: string;
  export default sql;
}
