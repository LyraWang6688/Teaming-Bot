export type FeishuApiResponse<T = unknown> = {
  code: number;
  msg?: string;
  data?: T;
};

export class FeishuOpenApiError extends Error {
  statusCode?: number;
  code?: number;
  method: string;
  path: string;
  body?: string;

  constructor(options: {
    message: string;
    method: string;
    path: string;
    statusCode?: number;
    code?: number;
    body?: string;
  }) {
    super(options.message);
    this.name = 'FeishuOpenApiError';
    this.statusCode = options.statusCode;
    this.code = options.code;
    this.method = options.method;
    this.path = options.path;
    this.body = options.body;
  }
}
