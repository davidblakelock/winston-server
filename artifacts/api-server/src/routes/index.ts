import { Router, type IRouter } from "express";
import healthRouter from "./health";
import chatRouter from "./chat";
import remindersRouter from "./reminders";
import transcribeRouter from "./transcribe";
import authRouter from "./auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(chatRouter);
router.use(remindersRouter);
router.use(transcribeRouter);

export default router;
