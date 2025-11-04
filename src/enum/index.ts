export enum JetStreamKind {
  Event = 'ev',
  Command = 'cmd',
}

export enum JetstreamHeaders {
  CorrelationId = 'correlation-id',
  ReplyTo = 'reply-to',
  MessageId = 'message-id',
  Subject = 'subject',
  User = 'user',
  CallerName = 'service-name',
  RequestId = 'request-id',
  TraceId = 'trace-id',
  SpanId = 'span-id',
}
