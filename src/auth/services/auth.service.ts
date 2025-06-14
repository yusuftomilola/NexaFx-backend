import {
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserService } from 'src/user/providers/user.service';
import { RegisterDto } from '../dto/register.dto';
import { LoginDto } from '../dto/login.dto';
import { BcryptPasswordHashingService } from './bcrypt-password-hashing.service';
import { CreateUserDto } from 'src/user/dto/create-user.dto';
import { Repository } from 'typeorm';
import { User } from 'src/user/entities/user.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { ethers } from 'ethers';
import { randomInt } from 'crypto';
import { Otp } from 'src/user/entities/otp.entity';
import { EmailService } from 'src/common/utils/email.service';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UserService,
    private readonly jwtService: JwtService,
    private readonly passwordService: BcryptPasswordHashingService,
    private readonly emailService: EmailService,
    @InjectRepository(User) private userRepo: Repository<User>,
    @InjectRepository(Otp) private otpRepo: Repository<Otp>,
  ) {}

  //Register User
  public async register(registerDto: RegisterDto) {
    const existingUser = await this.usersService.findOne(registerDto.email);
    if (existingUser) throw new ConflictException('Email is already in use');

    const hashedPassword = await this.passwordService.hash(
      registerDto.password,
    );
    const newUser = await this.usersService.create({
      ...registerDto,
      password: hashedPassword,
    });

    return this.login(newUser);
  }

  // Validate User Credentials
  public async validateUser(email: string, password: string): Promise<any> {
    const user = await this.usersService.findOne(email);
    if (user && (await this.passwordService.compare(password, user.password))) {
      return user;
    }
    throw new UnauthorizedException('Invalid credentials');
  }

  async linkWallet(userId: number, walletAddress: string, signature: string) {
    const user = await this.userRepo.findOne({
      where: { id: userId.toString() },
    });
    if (!user) throw new UnauthorizedException('User not found');

    const message = `Link wallet with nonce: ${user.walletNonce}`;

    let recoveredAddress: string;
    try {
      recoveredAddress = ethers.utils.verifyMessage(message, signature);
    } catch (err) {
      throw new UnauthorizedException('Invalid signature');
    }

    if (recoveredAddress.toLowerCase() !== walletAddress.toLowerCase()) {
      throw new UnauthorizedException('Signature verification failed');
    }

    user.walletAddress = walletAddress;
    user.walletNonce = crypto.randomUUID(); // rotate nonce after use

    return this.userRepo.save(user);
  }

  //Login Method (Generate JWT tokens)
  public async login(user: any) {
    const payload = { email: user.email, sub: user.id };

    return {
      accessToken: this.jwtService.sign(payload, { expiresIn: '15m' }),
      refreshToken: this.jwtService.sign(payload, { expiresIn: '7d' }), // No DB storage
    };
  }

  //Refresh Token Method (No DB lookup)
  public async refreshToken(token: string) {
    try {
      const decoded = this.jwtService.verify(token);
      const user = await this.usersService.findOne(decoded.email);
      if (!user) throw new UnauthorizedException('Invalid refresh token');

      return this.login(user); // Issue new tokens
    } catch (error) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }

  // generating otp

  public async reuestOtp(email: string) {
    try {
      const user = await this.usersService.findOne(email);
      if (!user) throw new ConflictException('invalid user does not exist');
      const otp = this.generateOtp();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes
      await this.otpRepo.save({ email, code: otp, expiresAt });
      await this.emailService.sendOtpEmail(email, otp);
    } catch (error) {
      // Re-throw known exceptions
      if (error instanceof HttpException) {
        throw error;
      }

      // Handle unexpected errors
      throw new InternalServerErrorException('Failed to generate and send OTP');
    }
  }
  // verifying otp
  async verifyOtp(email: string, code: string): Promise<boolean> {
    try {
      const record = await this.otpRepo.findOneBy({ email, code });

      if (!record) {
        return false; // OTP not found
      }

      const isExpired = record.expiresAt.getTime() < Date.now();

      if (isExpired) {
        await this.otpRepo.delete({ email, code }); // cleanup
        return false; // OTP expired
      }

      await this.otpRepo.delete({ email, code }); // one-time use
      return true;
    } catch (error) {
      console.error('Error verifying OTP:', error);
      throw new InternalServerErrorException(
        'Could not verify OTP at this time.',
      );
    }
  }

  //Logout (No DB token storage, so just return message)
  public async logout() {
    return { message: 'Logged out successfully' };
  }

  generateOtp(): string {
    return String(randomInt(100000, 999999));
  }
  generateAccessToken(user: User): string {
    return this.jwtService.sign({ sub: user.id }, { expiresIn: '1h' });
  }

  generateRefreshToken(user: User): string {
    return this.jwtService.sign(
      { sub: user.id },
      { expiresIn: '3d', secret: process.env.REFRESH_TOKEN_SECRET },
    );
  }

  async storeRefreshToken(userId: number, token: string) {
    const hash = await bcrypt.hash(token, 10);
    await this.usersService.updateRefreshToken(Number(userId), hash);
  }
}
