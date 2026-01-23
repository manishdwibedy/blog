
---
title: "Why Facebook is Finally Asking What You Actually Want to See"
description: "For years, social media algorithms have been like silent observers. They watched how long you lingered on a video, whether you hit the like button, or if you sent a reel to a friend. While these passive signals helped build the feeds we see today, they had a major flaw: watching something doesn't always mean you enjoyed it. Sometimes, we watch things out of habit, shock, or because we simply forgot to scroll. The Shift to True Interest: Meta engineers realized that to build a better Facebook Reels experience, they needed to stop guessing and start listening. This led to the creation of the User True Interest Survey (UTIS) model. Instead of just tracking your data, Meta began integrating direct feedback—asking users through mini-surveys if a video actually matched their personal interests."
pubDate: "2026-01-17"
author: "Manish Dwibedy"
tags: ["MachineLearning", "RecommendationSystems", "MetaEngineering","UserExperience", "DataScience", "AI"]
featured: true
---

## 1. Data Engineering: The "Engagement-Weighted" Corpus

Scraping the top 100 posts is a start, but for a 10-year dev, we need a **Silver-Standard Dataset** of at least 2,000–5,000 samples to avoid catastrophic forgetting or overfitting to a single "guru's" voice.

### The Pipeline:

1. **Scraping & Metadata Extraction:** Use `playwright` to scrape not just the text, but the **Engagement Velocity** (likes/comments per hour) and **Follower-to-Engagement ratio**.
2. **Denoising with LLMs:** LinkedIn posts often contain "noise" (tags, emojis, URLs). Use a smaller model (Phi-3) to perform **Semantic Cleaning**.
3. **Reverse Instruction Seed (RIS):** For each viral post, use a teacher model (Claude 3.5 Sonnet) to infer the "Latent Intent."
* *Input:* Viral Post
* *Prompt:* "Analyze this post's hook, body structure, and CTA. Reverse-engineer the specific instruction and context that would generate this output."
* *Output:* `{"instruction": "...", "context": "...", "response": "..."}`


---

## 2. Modeling: QLoRA with High-Rank Adapters

Since we are teaching *style* rather than *facts*, we focus on the **Attention Blocks** and **MLP Layers**.

### The Configuration:

* **Precision:** 4-bit NormalFloat (NF4) with Double Quantization.
* **Rank ():** 64. (Higher rank is necessary for nuanced style transfer;  is too "stiff" for creative prose).
* **Alpha ():** 128 (Scaling factor for the adapters).
* **Target Modules:** `q_proj`, `k_proj`, `v_proj`, `o_proj`, `gate_proj`, `up_proj`, `down_proj`. Targeting all linear layers ensures the model learns the "structural rhythm" of LinkedIn (e.g., the double newline cadence).


![QLoRA Adapter Injection for Stlye Transfer](../../assets/images/QLoRA.png)

### Hyperparameter Tuning for "Vibe":

```python
training_args = TrainingArguments(
    learning_rate=2e-4,
    lr_scheduler_type="cosine", # Smooth decay for style convergence
    weight_decay=0.01,
    optim="paged_adamw_32bit",
    warmup_ratio=0.03,
    group_by_length=True, # Efficiency for varying post lengths
)

```

---

## 3. Post-Training: DPO (Direct Preference Optimization)

Fine-tuning (SFT) teaches the model *how* to write. **DPO** teaches it *what we prefer*. This is where you eliminate "AI-isms" (e.g., "In the ever-evolving landscape...").

1. **Generate Candidate Pairs:** Use your SFT model to generate two versions of a post.
2. **Human/AI Ranking:** Rank them based on **"The Hook"** (does the first line force a "See More" click?).
3. **DPO Loss:** Minimize the log-likelihood of the "generic" post and maximize the "viral-style" post. This aligns the model's reward surface with LinkedIn's algorithm.

![DPO Training Progress: Reward Margin & KL Divergence](../../assets/images/DPO.png)

---

## 4. Evaluation: Beyond Perplexity

Standard metrics (BLEU/ROUGE) fail because LinkedIn writing is often non-grammatical. Instead, we implement a **Custom Evaluation Suite**:

### A. LLM-as-a-Judge (The Rubric)

Use GPT-4o as a proxy evaluator with a specific 5-point rubric:

1. **Hook Efficacy:** Is the first sentence < 10 words and provocative?
2. **Formatting (The Bento):** Are there clear breaks and bullet points?
3. **No-Fluff Index:** Is the "pulp" (useless adjectives) minimized?


![LLM-as-a-Judge Performance](../../assets/images/LLM-Judge.png)


### B. Embedding Drift (Cosine Similarity)

Compare the embeddings of your model’s output against the embeddings of your "Gold Set" (the top 100 viral posts) using `text-embedding-3-small`.



You want a similarity score  while maintaining high diversity.

### C. The "See More" Proxy

The most technical metric: use a classifier (BERT-based) trained on your scraped data to predict the **probability of high engagement** based purely on the text structure.

---

## 1. The DPO Objective Function

The goal is to move the policy  away from the "corporate-jargon" reference policy  toward the "high-engagement" distribution. Unlike PPO, DPO eliminates the need for an explicit reward model by utilizing the analytical relationship between the reward function and the optimal policy.

The DPO loss is defined as:


Where:

* : The "chosen" viral-style post.
* : The "rejected" generic GPT/Corporate-style post.
* : The KL-divergence constraint (typically  to  for style transfer).

---

## 2. Advanced Data Preparation

For this to work, you need **synthetic negative samples**. If you only train on "good" posts, the model won't learn what *not* to do.

### The Negative Sample Generator

1. Take your "Top 100" Gold Set ().
2. Pass  to a baseline model (e.g., Llama 3 Base) with the prompt: *"Rewrite this LinkedIn post to sound like a generic, boring corporate press release. Use words like 'groundbreaking', 'delighted', and 'synergy'."*
3. This gives you your  (rejected) samples. This creates a clear **gradient** between high-engagement prose and corporate noise.

---

## 3. Implementation (PyTorch + TRL)

Assuming you are using **QLoRA** for parameter efficiency, here is the DPO training setup focused on style-specific target modules.

```python
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from trl import DPOTrainer, DPOConfig
from peft import LoraConfig

# 1. Load your SFT-tuned checkpoint as both model and ref_model
model_id = "your-sft-linkedin-model"
model = AutoModelForCausalLM.from_pretrained(model_id, torch_dtype=torch.bfloat16, device_map="auto")
ref_model = AutoModelForCausalLM.from_pretrained(model_id, torch_dtype=torch.bfloat16, device_map="auto")

# 2. High-Rank LoRA for Nuance (r=64 is better for style than r=8)
peft_config = LoraConfig(
    r=64, 
    lora_alpha=128,
    target_modules=["q_proj", "v_proj", "k_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    lora_dropout=0.05,
    bias="none",
    task_type="CAUSAL_LM",
)

# 3. DPO Configuration
training_args = DPOConfig(
    beta=0.1, # Sensitivity to the reference model
    output_dir="./linkedin-dpo-v1",
    per_device_train_batch_size=4,
    gradient_accumulation_steps=4,
    learning_rate=5e-5, # Lower LR for DPO to prevent mode collapse
    lr_scheduler_type="cosine",
    logging_steps=10,
    max_length=1024,
    max_prompt_length=512,
)

# 4. Initialize Trainer
dpo_trainer = DPOTrainer(
    model,
    ref_model,
    args=training_args,
    beta=0.1,
    train_dataset=dataset["train"],
    tokenizer=tokenizer,
    peft_config=peft_config,
)

dpo_trainer.train()

```

---

## 4. Evaluation: The "Metric Suite"

You need to verify that the model isn't just memorizing hooks, but actually shifting its latent distribution.

### A. Reward Margin Monitoring

During DPO, monitor the **log-probability margin**:



If this margin increases over time while **KL Divergence** stays under , the model is successfully learning the preference surface without forgetting language fundamentals.

### B. Structural Entropy

Calculate the variance of line lengths. Viral LinkedIn posts have high **structural entropy** (short lines followed by long lists). Generic AI has low entropy (uniform paragraph lengths).

* **Target:** A  increase in line-length variance compared to the base model.

### C. Jargon Frequency Analysis

Run a regex-based scan for "GPT-isms" (e.g., "unlocking the potential," "tapestry," "delve").

* **Success Metric:** A reduction of these tokens by  compared to the SFT-only model.
