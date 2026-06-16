import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const posts = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/posts' }),
  schema: z.object({
    title: z.string(),
    date: z.date(),
    excerpt: z.string(),
    summary: z.string().optional(),
    category: z.enum(['robotics', 'embedded', 'computer-vision', 'web']),
    featured: z.boolean().default(false),
    github: z.string().url().optional(),
    demo_url: z.string().url().optional(),
    demo_video: z.string().optional(),
    technologies: z.array(z.string()).optional(),
    draft: z.boolean().default(false),
  }),
});

export const collections = { posts };
