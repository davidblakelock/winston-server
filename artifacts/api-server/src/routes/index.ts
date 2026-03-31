import { Router, type IRouter } from "express";
import healthRouter from "./health";
import chatRouter from "./chat";
import remindersRouter from "./reminders";
import transcribeRouter from "./transcribe";
import authRouter from "./auth";
import winddownRouter from "./winddown";
import memoryRouter from "./memory";
import onboardingRouter from "./onboarding";
import pushRouter from "./push";
import oliviaRouter from "./olivia";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(onboardingRouter);
router.use(chatRouter);
router.use(remindersRouter);
router.use(transcribeRouter);
router.use(winddownRouter);
router.use(memoryRouter);
router.use(pushRouter);
router.use(oliviaRouter);

export default router;
