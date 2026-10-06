import type { DataSchema } from '../data.types';

/** A small dataset definition for unit tests of the query builder, the catalog and the agent tools. */
export const BOOKS: DataSchema = {
  id: '00000000-0000-0000-0000-000000000001', key: 'books', title: 'Books', description: 'Ukrainian classics for a reading channel', entity: 'book',
  version: 3, dedup_key: ['isbn'], language: 'uk', default_license: 'own', reuse_policy: { kind: 'after_days', days: 365 }, suitable_for: 'book clubs, literature channels',
  contains_personal_data: false, legacy: null, status: 'active', created_by: null, created_at: '', updated_at: '',
  roles: { title: 'title', body: 'summary', category: 'genre', month_day: 'birthday' },
  fields: [
    { name: 'isbn', type: 'text', description: 'ISBN', agent_visible: false, filterable: true },
    { name: 'title', type: 'text', description: 'Title', searchable: true },
    { name: 'summary', type: 'long_text', description: 'Summary' },
    { name: 'genre', type: 'enum', description: 'Genre', enum: ['novel', 'poetry'], filterable: true },
    { name: 'pages', type: 'int', description: 'Pages', filterable: true },
    { name: 'tags', type: 'text_list', description: 'Tags', filterable: true },
    { name: 'birthday', type: 'month_day', description: 'Author birthday', filterable: true },
    { name: 'old_note', type: 'text', description: 'Old', deprecated: true },
    { name: 'raw', type: 'json', description: 'Raw', filterable: true },
  ],
};
