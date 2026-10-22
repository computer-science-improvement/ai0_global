/**
 * Spec 065 FR-005: a trimmed copy of the structure of https://github.com/ZeroLu/awesome-nanobanana-pro (README.md, 72
 * entries, ~100 KB). Five entries — a plain text prompt, a JSON prompt, an entry without an image, an entry with two
 * images (input and result) and a prompt that holds lines looking like headings — between sponsor blocks, the table of
 * contents and a Resources section. Prompts are cut to a few lines; the shape is the original's.
 */
const F = '```';

export const NANOBANANA_URL = 'https://github.com/ZeroLu/awesome-nanobanana-pro';
export const NANOBANANA_RAW_URL = 'https://raw.githubusercontent.com/ZeroLu/awesome-nanobanana-pro/main/README.md';

export const NANOBANANA_README = `Last updated on 2026-10-22 02:37:08
#### Please also check out 👉 [this awesome repo of Seedance 2.0 prompts!](https://github.com/ZeroLu/awesome-seedance) 👈

# Awesome Nano Banana Pro 🍌

[![Awesome](https://cdn.rawgit.com/sindresorhus/awesome/d7305f38d29fed78fa85652e3a63e154dd8e8829/media/badge.svg)](https://github.com/sindresorhus/awesome) [![License: CC BY 4.0](https://img.shields.io/badge/License-CC_BY_4.0-lightgrey.svg)](https://creativecommons.org/licenses/by/4.0/)

<a href="https://trendshift.io/repositories/21624" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/21624/weekly" alt="ZeroLu%2Fawesome-nanobanana-pro | Trendshift" width="250" height="55"/></a>

> A curated collection of the **best Nano Banana prompts**, image generation styles, and resources for advanced AI visual experiments.

### Sponsor1

| Image | Description |
| :---: | :--- |
| <img width="400" alt="image" src="https://github.com/user-attachments/assets/39087148-9caa-4b37-8563-2da68df19713" /> | Thanks to APIMart for sponsoring this project! APIMart is a low-cost API platform for AI image & video generation. [sign up here](https://go.apimart.ai/gh-awesome-nanobanana-pro) to get started. |

### Sponsor2
[![Cyberbara Ad](./assets/cyberbara-real-face-upload-banner.webp)](https://cyberbara.com/seedance2.0?utm_source=banana)

> **💡 Struggle with Seedance 2.0 Face Detection?**
> Cyberbara now supports **real face uploads without limits!** [Unlock your limits at cyberbara.com →](https://cyberbara.com/seedance2.0?utm_source=banana)

## 📖 Table of Contents

1. [Photorealism & Aesthetics](#1-photorealism--aesthetics)
2. [Creative Experiments](#2-creative-experiments)
3. [Resources](#3-resources)

---

## 1. Photorealism & Aesthetics

Optimize your visual output with these **high-fidelity prompts**.

### 1.1. Hyper-Realistic Crowd Composition
*Handling complex compositions with multiple famous faces and specific lighting.*
<img width="400" alt="Celebrity Crowd" src="https://github.com/user-attachments/assets/3a056a8d-904e-4b3e-b0d2-b5122758b7f5" />

**Prompt:**
${F}text
Create a hyper-realistic, ultra-sharp, full-color large-format image featuring a massive group of celebrities from different eras, all standing together in a single wide cinematic frame.

GENERAL STYLE & MOOD: Photorealistic, 8k, shallow depth of field, soft natural fill light + strong golden rim light.

THE ENVIRONMENT: A luxurious open-air rooftop terrace at sunset overlooking a modern city skyline.
${F}
*Source: [@SebJefferies](https://x.com/SebJefferies/status/1991531687147360728)*

### 1.2. 2000s Mirror Selfie
*A structured JSON prompt to generate an authentic early-2000s aesthetic with flash photography and nostalgic elements.*
<img width="300" height="400" alt="Image" src="https://github.com/user-attachments/assets/b71755dc-ff33-4872-8161-3f5066e0ccb6" />

**Prompt:**
${F}json
Create a 2000s Mirror Selfie of yourself using Gemini Nano Banana.

{
  "subject": {
    "description": "A young woman taking a mirror selfie with very long voluminous dark waves",
    "hair": {
      "color": "dark",
      "style": "very long, voluminous waves with soft wispy bangs"
    }
  },
  "camera": { "flash": true, "style": "early-2000s compact camera" }
}
${F}
*Source: [@kimmonismus](https://x.com/kimmonismus/status/1992001234567890123)*

### 1.3. Chalkboard Notes (no picture yet)
*A prompt whose example image is not published in the list.*

**Prompt:**
${F}text
Draw a chalkboard covered in neat handwritten notes about photosynthesis.
${F}
*Source: [@teacherbot](https://x.com/teacherbot/status/1993000000000000001)*

## 2. Creative Experiments

### 2.1. Ironing Out Wrinkles
*Turns a crumpled photo into a smooth one.*
<p align="center">
  <img width="200" src="https://github.com/user-attachments/assets/e41db56f-d928-400c-b21b-f8a0d53ba91b" alt="Original" />
  <img width="250" src="https://github.com/user-attachments/assets/793ad242-7867-4709-bdc6-55021f5eb78f" alt="Generated" />
</p>

**Prompt:**
${F}text
Iron out the wrinkles of the uploaded photo and keep every detail of the scene.
${F}
*Source: Ethan Mollick ([@emollick](https://x.com/emollick)) - [Post](https://x.com/emollick/status/1995720976068137048?s=20)*

### 2.2. Prompt With Hash Lines
*A prompt that has lines starting with # inside its code block.*
| Reference | Result |
| :--- | :--- |
| <img width="100" src="https://replicate.delivery/pbxt/abc/guy.webp" /> | <img width="100" src="https://replicate.delivery/pbxt/abc/out.webp" /> |

**Prompt:**
${F}text
# Scene
A quiet street at dawn.

## Lighting
Soft pink light from the left.
${F}
*Source: [Replicate](https://replicate.com/)*

## 3. Resources

- [Awesome Prompts](https://github.com/example/awesome-prompts)

## 4. Contributing

Send a pull request.
`;
