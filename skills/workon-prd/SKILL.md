---
name: workon-prd
description: 根据 TASK.md 和 knowledge 撰写 PRD。信息不足或没有把握时停止并说明原因。
---

# 撰写 PRD

1. 阅读当前目录的 TASK.md，以及 knowledge/ 下的 Markdown。
2. 信息足够时，把 PRD 写到 artifacts/prd.md。PRD 包含背景、目标、非目标、用户与流程、验收标准。
3. 同时把 report.json 写在当前目录，不要放进 artifacts/：`{"outcome":"completed","reason":""}`。
4. 信息不足，或没有把握继续时，不要猜测。不写 prd.md。把 report.json 写在当前目录：`{"outcome":"blocked","reason":"具体缺什么"}`。
5. 只在当前任务目录内创建或修改文件。
