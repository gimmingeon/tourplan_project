import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { RegisterDto } from './dto/register.dto';
import { UpdateUserDto } from './dto/user.update.dto';
import { User } from './entities/user.entity';
import { Repository } from 'typeorm';
import { compare, hash } from 'bcrypt';
import { LoginDto } from './dto/login.dto';
import _ from 'lodash';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { UtilsService } from 'src/utils/utils.service';
import { AwsService } from 'src/aws/aws.service';
import { MailerService } from 'src/mailer/mailer.service';
import { RedisService } from 'src/redis/redis.service';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly utilsService: UtilsService,
    private readonly awsService: AwsService,
    private readonly redisService: RedisService,
    private readonly mailerService: MailerService
  ) {}

  async register(registerDto: RegisterDto) {
    const existingUser = await this.userRepository.findOne({
      where: { email: registerDto.email },
    });

    if (existingUser) {
      throw new ConflictException('이미 해당 이메일로 가입된 사용자가 있습니다.',);
    }

    const hashedPassword = await hash(registerDto.password, 10)

    await this.userRepository.save({
      email: registerDto.email,
      password: hashedPassword,
      name: registerDto.name,
      nickname: registerDto.nickname,
      phone: registerDto.phone
    });

    return {message: '회원가입이 완료되었습니다.'}
  }

  async login(loginDto: LoginDto) {
    const user = await this.userRepository.findOne({
      select: ['id', 'email', 'password'], // 유저 엔터티에서 id, email, password 필드만 선택
      where: { email: loginDto.email }, // userRepository에서 제공된 이메일로 사용자 찾음
    });
    if (!user) {
      throw new UnauthorizedException('이메일을 확인해주세요.');
    }

    if (!(await compare(loginDto.password, user.password))) {
      throw new UnauthorizedException('비밀번호를 확인해주세요.');
    }

    // 사용자가 일치하면 jwt 토큰 페이로드 구성
    const payload = { email: user.email, sub: user.id };
    return {
      access_token: this.jwtService.sign(payload, { expiresIn: '300s' }),
      refresh_token: this.jwtService.sign(payload, { expiresIn: '7d' }),
    };
  }

  async update(
    id: number, 
    updateUserDto: UpdateUserDto,
    file?: Express.Multer.File
    ) {
    
    // 유저 확인
    const user = await this.userRepository.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException('사용자를 찾을 수 없습니다.');
    }

    let imageUrl = user.image_url;

    if (file) {
    //이미 입력된 이미지가 있다면 S3에서 기존 이미지 삭제
    if (user.image_url !== null) {
      await this.awsService.deleteUploadToS3(user.image_url);
    }
  }
  
    //S3에 이미지 업로드, url return
    const imageName = this.utilsService.getUUID();
    const ext = file? file.originalname.split('.').pop() : null;
  
    if (ext) {
    imageUrl = await this.awsService.imageUploadToS3(
      `${imageName}.${ext}`,
      file,
      ext,
    );
    }

    // DB에 저장
    const modifiedUser = await this.userRepository.save({
      id: user.id,
      nickname: updateUserDto.nickname,
      phone: updateUserDto.phone,
      image_url: `${imageName}.${ext}`,
    })

    return modifiedUser
  }

  async sendVerification(email: string) {
    await this.mailerService.sendVerifyToken(email)
  }

  async verifyUser(email: string, code: string) {
    const redisClient = this.redisService.getClient()
    const key = `verification_code:${email}`
    const storedCode = await redisClient.get(key)

    if (!storedCode) {
      throw new BadRequestException('이메일 발송을 해주세요.')
    }

    if (code === storedCode) {
      // 인증코드가 일치하면 레디스 키를 삭제
      await redisClient.del(key);
      return {message: '인증이 완료되었습니다.'};
    }
    return {message: '인증번호가 일치하지 않습니다.'}
  }

  async remove(userId: number, id: number) {
    const user = await this.findById(id)

    if(userId !== id) {
      throw new NotFoundException('유저를 찾을 수 없습니다.')
    }

    await this.userRepository.delete({id : id})
    return {message: '회원탈퇴가 완료되었습니다.'}
  }

  async findByEmail(email: string) {
    return await this.userRepository.findOneBy({ email });
  }
  async findById(id: number) {
    return await this.userRepository.findOneBy({ id });
  }
}
