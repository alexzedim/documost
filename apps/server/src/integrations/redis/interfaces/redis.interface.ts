export interface RedisConfig {
  host: string;
  port: number;
  db: number;
  password?: string;
  family?: number;
}
